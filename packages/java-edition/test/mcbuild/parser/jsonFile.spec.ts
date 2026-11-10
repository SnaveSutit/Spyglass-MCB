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
		assert.deepEqual(errors, ['Unexpected end of file'])
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
})
