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
})
