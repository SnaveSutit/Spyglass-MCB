import { testParser } from '@spyglassmc/core/test/utils.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mcbParser, realArgument } from './utils.ts'

/** No "Expected more arguments" after `run { }`; real `execute` errors still surface. */
describe('mcbuild parser (execute … run)', () => {
	function messages(fnBody: string): string[] {
		const content = `function t {\n\t${fnBody}\n}\n`
		return testParser(mcbParser(realArgument), content, {
			uri: 'file:///pack/data/p/t.mcb',
			noNodeReturn: true,
		}).errors.map((e) => e.message)
	}

	const clean = [
		'execute if score a b matches 1 run {\n\t\tsay hi\n\t}',
		'execute run {\n\t\tsay hi\n\t}',
		'execute as @a at @s run {\n\t\tsay hi\n\t}',
		'execute if score a b matches 1 run say hi',
		'execute if score a b matches 1 run execute run say hi',
		'execute if score a b matches 1 run {\n\t\tsay 1\n\t} else run {\n\t\tsay 2\n\t}',
		'execute if score a b matches 1 run {\n\t\tsay 1\n\t} else if score a b matches 2 run {\n\t\tsay 2\n\t}',
		'execute unless {\n\t\tsay 1\n\t} run say tail',
		'execute if {\n\t\tsay 1\n\t} run {\n\t\tsay block tail\n\t}',
		'execute if {\n\t\tsay 1\n\t} if {\n\t\tsay 2\n\t} as @a run say chained',
		'execute if {\n\t\tsay 1\n\t}',
	]
	for (const body of clean) {
		it(`no spurious error: ${JSON.stringify(body)}`, () => {
			assert.deepEqual(messages(body), [])
		})
	}

	it('still flags a real error inside the execute clause', () => {
		const msgs = messages('execute if score @notaselector[bad=] run {\n\t\tsay hi\n\t}')
		assert.ok(msgs.length > 0)
		assert.ok(!msgs.includes('Expected more arguments'), JSON.stringify(msgs))
	})

	it('still flags a missing run before the block', () => {
		assert.deepEqual(messages('execute if score a b matches 1 {\n\t\tsay hi\n\t}'), [
			'Expected more arguments',
		])
	})

	it('chains a tail after a condition block onto the execute', () => {
		const node = testParser(
			mcbParser(realArgument),
			'function t {\n\texecute unless {\n\t\tsay 1\n\t} run say tail\n\tsay next\n}\n',
			{ uri: 'file:///pack/data/p/t.mcb' },
		).node as { children: { body: { children: { type: string; tail?: { type: string } }[] } }[] }
		const statements = node.children[0].body.children
		assert.deepEqual(statements.map((s) => s.type), ['mcbuild:execute_block', 'mcbuild:command'])
		assert.equal(statements[0].tail?.type, 'mcbuild:execute_run')
	})

	it('still flags an error in the tail', () => {
		assert.ok(
			messages('execute unless {\n\t\tsay 1\n\t} if score @notaselector[bad=] run say hi').length
				> 0,
		)
	})
})
