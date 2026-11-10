import { Logger, MetaRegistry, ParserContext, Source } from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import type { EntryNode } from '@spyglassmc/java-edition/lib/mcbuild/node/index.js'
import { entry } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { realArgument, tree } from './utils.ts'

const parser = entry({ tree, argument: realArgument, commandOptions: {} })

function parse(content: string, uri = 'file:///pack/src/main.mcb') {
	const project = mockProjectData({ meta: new MetaRegistry(), logger: Logger.create() })
	const doc = TextDocument.create(uri, 'mc-build', 0, content)
	const ctx = ParserContext.create(project, { doc })
	const node = parser(new Source(content), ctx) as EntryNode
	return { node, errors: ctx.err.dump().map((e) => e.message) }
}

const scopeError = 'Escaped comments (“\\#”) are only valid inside a function or template body'

describe('mcbuild parser — escaped `\\#` comments', () => {
	it('keeps them as comments in function and block bodies', () => {
		const { node, errors } = parse(
			'function t {\n\t\\# kept {\n\tblock {\n\t\t\\# also kept\n\t}\n}',
		)
		assert.deepEqual(errors, [])
		const body = (node.children[0] as { body: { children: { type: string }[] } }).body
		assert.equal(body.children[0].type, 'comment')
	})

	it('allows them in template bodies', () => {
		const { errors } = parse(
			'template t {\n\t\\# note\n\twith {\n\t\t\\# kept\n\t}\n}',
			'file:///pack/src/lib.mcbt',
		)
		assert.deepEqual(errors, [])
	})

	it('rejects them at the top level, like mc-build', () => {
		assert.deepEqual(parse('\\# top\ndir d {\n\t\\# in dir\n}').errors, [scopeError, scopeError])
		assert.deepEqual(parse('\\# top', 'file:///pack/src/lib.mcbt').errors, [scopeError])
	})
})
