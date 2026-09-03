import { Logger, MetaRegistry, ParserContext } from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import type { JsNode } from '@spyglassmc/java-edition/lib/mcbuild/node/index.js'
import { parseJs } from '@spyglassmc/java-edition/lib/mcbuild/parser/js.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

function run(source: string, base: number, context: JsNode['context']) {
	const ctx = ParserContext.create(
		mockProjectData({ meta: new MetaRegistry(), logger: Logger.create() }),
		{ doc: TextDocument.create('file:///t.mcb', 'mc-build', 0, ' '.repeat(base) + source) },
	)
	const node = parseJs(source, base, context, ctx)
	return { node, errors: ctx.err.dump() }
}

describe('mcbuild parseJs()', () => {
	it('accepts a valid expression with no diagnostics', () => {
		const { node, errors } = run('a + b(c)', 10, 'expression')
		assert.equal(errors.length, 0)
		assert.equal(node.loose, false)
		assert.equal(node.range.start, 10)
	})

	it('accepts a valid multiline script (globals are not checked)', () => {
		const { errors } = run(
			'const x = 1;\nstore.foo = x;\nemit.mcb(`say ${config.name}`);',
			0,
			'multiline',
		)
		assert.equal(errors.length, 0)
	})

	it('accepts a bare member-expression assignment in a script block', () => {
		const { errors } = run("store.board_root_uuid = '68fa21c9'", 0, 'multiline')
		assert.equal(errors.length, 0)
	})

	it('reports a syntax error and marks the span loose', () => {
		const { node, errors } = run('1 +', 0, 'expression')
		assert.equal(node.loose, true)
		assert.ok(errors.length >= 1)
		// The error range must stay inside the span.
		assert.ok(errors[0].range.start >= 0 && errors[0].range.end <= node.range.end)
	})

	it('reports empty expression spans', () => {
		const { errors } = run('   ', 5, 'inline')
		assert.equal(errors.length, 1)
	})

	it('does not report empty multiline script spans', () => {
		const { errors } = run('   ', 5, 'multiline')
		assert.equal(errors.length, 0)
	})
})
