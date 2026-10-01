import { Logger, MetaRegistry, ParserContext, Source } from '@spyglassmc/core'
import type * as core from '@spyglassmc/core'
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
	return { node, errors: ctx.err.dump() }
}

const text = (content: string, range: core.Range) => content.slice(range.start, range.end)

describe('mcbuild parser — source ranges', () => {
	it('ranges a name that also occurs inside its keyword', () => {
		for (
			const [content, name] of [
				['function t {\n}', 't'],
				['function fun {\n}', 'fun'],
				['dir d {\n}', 'd'],
				['clock c 1t {\n}', 'c'],
			]
		) {
			const { node } = parse(content)
			const id = (node.children[0] as { id: { range: core.Range } }).id
			assert.equal(id.range.start, content.lastIndexOf(name), content)
			assert.equal(text(content, id.range), name)
		}
	})

	it('ranges a template name and `with` params that occur inside their keywords', () => {
		const content = 'template t {\n\twith with w:int {\n\t}\n}'
		const { node } = parse(content, 'file:///pack/src/t.mcbt')
		const template = node.children[0] as {
			id: { range: core.Range }
			overloads: { params: { range: core.Range }[] }[]
		}
		assert.equal(template.id.range.start, 'template '.length)
		const params = template.overloads[0].params.map((p) => text(content, p.range))
		assert.deepEqual(params, ['with', 'w:int'])
		assert.equal(template.overloads[0].params[0].range.start, content.indexOf('with with') + 5)
	})

	it('places a REPEAT expression error on the source, not a rewritten copy', () => {
		const content = 'function t {\n\tREPEAT (1 +) as i {\n\t}\n}'
		const { errors } = parse(content)
		assert.equal(errors.length, 1)
		assert.equal(text(content, errors[0].range), ')')
	})

	it('never reports an inverted range for a JS error at the end of a span', () => {
		const content = 'function t {\n\tsay <%1 +%>\n}'
		const { errors } = parse(content)
		assert.equal(errors.length, 1)
		const { start, end } = errors[0].range
		assert.ok(start <= end, `inverted range ${start}-${end}`)
		assert.ok(start >= content.indexOf('1 +') && end <= content.indexOf('%>'))
	})

	it('maps interpolation on a `\\`-continued line to its physical location', () => {
		const content = 'function t {\n\tsay hi \\\n\t\t<%foo%> bar\n}'
		const { node } = parse(content)
		const fn = node.children[0] as unknown as {
			body: { children: { interpolation: { type: string; range: core.Range }[] }[] }
		}
		const [, js, tail] = fn.body.children[0].interpolation
		assert.equal(text(content, js.range), 'foo')
		assert.equal(text(content, tail.range), ' bar')
	})
})

describe('mcbuild parser — execute', () => {
	it('parses `execute … run <statement> {` inline, like mc-build', () => {
		const content = 'function t {\n\texecute as @s run schedule 1t {\n\t\tsay hi\n\t}\n}'
		const { node, errors } = parse(content)
		assert.deepEqual(errors, [])
		const fn = node.children[0] as unknown as {
			body: { children: { type: string; statement?: { type: string } }[] }
		}
		const stmt = fn.body.children[0]
		assert.equal(stmt.type, 'mcbuild:execute_run')
		assert.equal(stmt.statement?.type, 'mcbuild:schedule_block')
	})

	it('does not split on a `run` that is not the run keyword', () => {
		const { errors } = parse('function t {\n\texecute as @s[tag=run] run say hi\n}')
		assert.deepEqual(errors, [])
	})
})
