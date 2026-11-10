import { Logger, MetaRegistry, ParserContext, Source } from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import type { EntryNode, JsonFileNode } from '@spyglassmc/java-edition/lib/mcbuild/node/index.js'
import { entry } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { realArgument, tree } from './utils.ts'

const parser = entry({ tree, argument: realArgument, commandOptions: {} })

function parse(content: string) {
	const project = mockProjectData({ meta: new MetaRegistry(), logger: Logger.create() })
	const doc = TextDocument.create('file:///pack/src/main.mcb', 'mc-build', 0, content)
	const ctx = ParserContext.create(project, { doc })
	const node = parser(new Source(content), ctx) as EntryNode
	return { node, errors: ctx.err.dump().map((e) => e.message) }
}

/** The JSON body source of the first data file, and the types of every top-level node. */
function bodyOf(content: string) {
	const { node, errors } = parse(content)
	const file = node.children[0] as JsonFileNode
	const body = file.entries[0]
	return {
		errors,
		body: body && content.slice(body.range.start, body.range.end),
		types: node.children.map((c) => c.type),
	}
}

describe('mcbuild parser — JSON data files', () => {
	it('closes a bracket that shares a line with a value', () => {
		const content = 'predicate on_ground {\n'
			+ '\t"type": "entity_properties",\n'
			+ '\t"predicate": {\n'
			+ '\t\t"flags": {\n'
			+ '\t\t\t"is_on_ground": true}\n'
			+ '\t}\n'
			+ '}\n'
			+ 'function f {\n\tsay hi\n}\n'
		const { errors, body, types } = bodyOf(content)
		assert.deepEqual(errors, [])
		assert.equal(body, content.slice(content.indexOf('{'), content.indexOf('\nfunction')))
		assert.deepEqual(types, ['mcbuild:json_file', 'mcbuild:function_definition'])
	})

	it('ignores brackets inside strings and `<% %>`', () => {
		const content = 'predicate p {\n\t"a": "}",\n\t"b": <%"]}"%>\n}\nfunction f {\n}\n'
		const { types } = bodyOf(content)
		assert.deepEqual(types, ['mcbuild:json_file', 'mcbuild:function_definition'])
	})

	it('reads single-line and array bodies', () => {
		const single = bodyOf('predicate p { "type": "x" }\nfunction f {\n}\n')
		assert.deepEqual(single.errors, [])
		assert.equal(single.body, '{ "type": "x" }')
		assert.deepEqual(single.types, ['mcbuild:json_file', 'mcbuild:function_definition'])

		const array = bodyOf('predicate p [\n\t{ "type": "x" }\n]\nfunction f {\n}\n')
		assert.deepEqual(array.errors, [])
		assert.equal(array.body, '[\n\t{ "type": "x" }\n]')
		assert.deepEqual(array.types, ['mcbuild:json_file', 'mcbuild:function_definition'])
	})

	it('skips `#` comment lines', () => {
		const { errors } = bodyOf('predicate p {\n\t# a note\n\t"type": "x"\n}\n')
		assert.deepEqual(errors, [])
	})

	it('reports an unclosed body at the end of the file', () => {
		const { errors } = bodyOf('predicate p {\n\t"type": "x"\n')
		assert.deepEqual(errors, ['Expected “}” to close this'])
	})

	it('reads the 4.3 registry keywords', () => {
		const { node, errors } = parse(
			'painting_variant p {\n\t"width": 1\n}\ntrim_material t { "a": 1 }\n',
		)
		assert.deepEqual(errors, [])
		const files = node.children as JsonFileNode[]
		assert.deepEqual(files.map((f) => [f.kind, f.id.value]), [
			['painting_variant', 'p'],
			['trim_material', 't'],
		])
	})

	it('reads `json <folder> <name>` with nested folders and names', () => {
		const { node, errors } = parse('json a/b nested/name {\n\t"x": 1\n}\n')
		assert.deepEqual(errors, [])
		const file = node.children[0] as JsonFileNode
		assert.deepEqual([file.kind, file.registry?.value, file.id.value], [
			'json',
			'a/b',
			'nested/name',
		])
	})

	it('keeps `<% %>` header words whole and stops a word at `[`', () => {
		const { node, errors } = parse('json foo <% "a b" %> [1, 2]\n')
		assert.deepEqual(errors, [])
		const file = node.children[0] as JsonFileNode
		assert.equal(file.id.value, '<% "a b" %>')
		assert.equal(bodyOf('json foo arr[1, 2]\n').body, '[1, 2]')
	})

	it('reads a braceless value to the end of its line', () => {
		const { body, types } = bodyOf('json foo n 1\nfunction f {\n}\n')
		assert.equal(body, '1')
		assert.deepEqual(types, ['mcbuild:json_file', 'mcbuild:function_definition'])
	})

	it('reports a missing header word or value', () => {
		assert.deepEqual(parse('json foo\n').errors, [
			'Incomplete data file header; expected “json <folder> <name> <value>”',
		])
		assert.deepEqual(parse('json foo bar\n').errors, ['Expected a JSON value'])
	})

	it('splits a one-line tag body on commas outside `<% %>`', () => {
		const { node, errors } = parse(
			'tag blocks t replace { minecraft:stone, minecraft:dirt replace, #minecraft:logs, <% "a,b" %> }\n'
				+ 'function f {\n}\n',
		)
		assert.deepEqual(errors, [])
		const file = node.children[0] as JsonFileNode
		assert.ok(file.replace)
		assert.equal(file.entries.length, 4)
		const content =
			'tag blocks t replace { minecraft:stone, minecraft:dirt replace, #minecraft:logs, <% "a,b" %> }'
		const texts = (file.entries as { range: { start: number; end: number }; replace?: unknown }[])
			.map((e) => [content.slice(e.range.start, e.range.end), !!e.replace])
		assert.deepEqual(texts, [
			['minecraft:stone', false],
			['minecraft:dirt replace', true],
			['#minecraft:logs', false],
			['<% "a,b" %>', false],
		])
		assert.equal(node.children[1].type, 'mcbuild:function_definition')
	})

	describe('relaxed JSON', () => {
		/** The keys of the body's root object, `undefined` for dynamic ones. */
		function keysOf(content: string) {
			const { node, errors } = parse(content)
			const value = (node.children[0] as JsonFileNode).entries[0] as {
				value?: { children: { key?: { value: string } }[] }
			}
			return { errors, keys: value.value?.children.map((p) => p.key?.value) }
		}

		it('accepts unquoted keys and words, single quotes, comments and no commas', () => {
			const { errors, keys } = keysOf(
				"predicate p {\n\ttype: entity_properties // why\n\t'b': 'x' /* c */\n\tc: [1 2, true null]\n}\n",
			)
			assert.deepEqual(errors, [])
			assert.deepEqual(keys, ['type', 'b', 'c'])
		})

		it('reports what mc-build rejects', () => {
			const errorsOf = (body: string) => parse(`predicate p { ${body} }\n`).errors
			assert.deepEqual(errorsOf('"a" 1'), [
				'Expected “:” after the key',
				'Expected a key; keys other than plain words must be quoted',
			])
			assert.deepEqual(errorsOf('a: b:c'), [
				"Unquoted strings can't contain “:”; wrap the value in quotes",
			])
			assert.deepEqual(errorsOf('a: #minecraft:logs'), [
				'Tag references must be quoted, like “"#minecraft:logs"”',
			])
			assert.deepEqual(errorsOf('a: 1,, b: 2'), ['Unexpected “,”'])
			assert.deepEqual(errorsOf('a: 1x'), ['Invalid number'])
		})

		it('merges every IF/ELSE branch and REPEAT body into the object', () => {
			const { errors, keys } = keysOf(
				'json c config {\n\t"always": 1,\n\tIF (true) {\n\t\t"on": true\n\t} ELSE IF (false) {\n\t\t"maybe": 1\n\t}\n'
					+ '\tELSE {\n\t\t"off": true\n\t}\n\tREPEAT([1, 2]) as n {\n\t\t"key_<%n%>": <%n%>,\n\t}\n\t"done": true\n}\n',
			)
			assert.deepEqual(errors, [])
			assert.deepEqual(keys, ['always', 'on', 'maybe', 'off', undefined, 'done'])
		})

		it('warns on duplicate keys, but not between branches of one IF/ELSE', () => {
			const { errors } = keysOf(
				'json c f {\n\tIF (x) {\n\t\t"a": 1\n\t} ELSE {\n\t\t"a": 2\n\t}\n\t"b": 1\n\t"b": 2\n}\n',
			)
			assert.deepEqual(errors, ['Duplicate key “b”; the last value wins'])
		})

		it('treats `<% %>` keys, values and entries as dynamic', () => {
			const { errors, keys } = keysOf(
				'json c f {\n\t<% spread %>\n\ta: "x_<%y%>"\n\t<%k%>: 1\n}\n',
			)
			assert.deepEqual(errors, [])
			assert.deepEqual(keys, [undefined, 'a', undefined])
		})

		it('reports JavaScript errors in conditions and values', () => {
			const { errors } = parse('json c f {\n\tIF (1 +) {\n\t}\n\ta: <% ) %>\n}\n')
			assert.equal(errors.length, 2, JSON.stringify(errors))
		})

		it('reports an unclosed block and text after its `}`', () => {
			assert.deepEqual(parse('json c f {\n\tIF (x) {\n\t\ta: 1\n').errors, [
				'Expected “}” to close this block',
				'Expected “}” to close this',
			])
			assert.deepEqual(parse('json c f {\n\tREPEAT(x) as i {\n\t} oops {\n}\n').errors, [
				'Unexpected “oops {” after “}”',
			])
		})
	})
})
