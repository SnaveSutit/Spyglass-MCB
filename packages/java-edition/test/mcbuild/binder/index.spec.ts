import {
	BinderContext,
	Failure,
	Logger,
	MetaRegistry,
	ParserContext,
	Source,
} from '@spyglassmc/core'
import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import {
	fileBase,
	FUNCTION_CATEGORY,
	getTemplateData,
	register as registerBinder,
	resolveFunctionId,
	TEMPLATE_CATEGORY,
	VANILLA_FUNCTION_CATEGORY,
} from '@spyglassmc/java-edition/lib/mcbuild/binder/index.js'
import type { ReferenceNode } from '@spyglassmc/java-edition/lib/mcbuild/node/index.js'
import { entry } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { tree } from '../parser/utils.ts'

const mcbEntry = entry({ tree, argument: () => undefined, commandOptions: {} })

function bind(uri: string, content: string) {
	const meta = new MetaRegistry()
	registerBinder(meta)
	const project = mockProjectData({ meta, logger: Logger.create() })
	const doc = TextDocument.create(uri, 'mcbuild', 0, content)
	const node = mcbEntry(new Source(content), ParserContext.create(project, { doc }))
	if (node === Failure) {
		throw new Error('parse failed')
	}
	core.AstNode.setParents(node)
	void meta.getBinder(node.type)(node, BinderContext.create(project, { doc }))
	return project.symbols
}

describe('mcbuild binder', () => {
	it('registers a template symbol with its overloads', () => {
		const symbols = bind(
			'file:///pack/src/t.mcbt',
			'template greet {\n\twith name:raw {\n\t\tsay hi\n\t}\n\twith {\n\t\tsay bye\n\t}\n}',
		)
		const symbol = symbols.global[TEMPLATE_CATEGORY]?.['greet']
		assert.ok(symbol, 'greet template symbol should exist')
		const data = getTemplateData(symbol)
		assert.deepEqual(data?.overloads, [
			{ params: [{ name: 'name', kind: 'raw' }] },
			{ params: [] },
		])
	})

	it('keeps mixed literal and typed params in source order', () => {
		const symbols = bind(
			'file:///pack/src/t.mcbt',
			'template setup {\n\twith mode a:int b:block {\n\t\tsay hi\n\t}\n}',
		)
		const data = getTemplateData(symbols.global[TEMPLATE_CATEGORY]?.['setup'])
		assert.deepEqual(data?.overloads[0]?.params, [
			{ name: 'mode', kind: 'literal' },
			{ name: 'a', kind: 'int' },
			{ name: 'b', kind: 'block' },
		])
	})

	it('registers dir-scoped function paths when the file is not under src/', () => {
		const symbols = bind(
			'file:///pack/data/p/main.mcb',
			'dir features {\n\tfunction spawn {\n\t\tsay hi\n\t}\n}\nfunction root {\n}',
		)
		const fns = Object.keys(symbols.global[FUNCTION_CATEGORY] ?? {}).sort()
		assert.deepEqual(fns, ['features/spawn', 'root'])
	})

	it('registers fully-qualified ids under src/ as vanilla functions', () => {
		const symbols = bind(
			'file:///pack/src/main.mcb',
			'dir features {\n\tfunction spawn {\n\t\tsay hi\n\t}\n}\nfunction root {\n}',
		)
		const fns = Object.keys(symbols.global[VANILLA_FUNCTION_CATEGORY] ?? {}).sort()
		assert.deepEqual(fns, ['main:features/spawn', 'main:root'])
	})

	it('nests the file path into the id for a non-namespace-root file', () => {
		const symbols = bind(
			'file:///pack/src/foo/bar.mcb',
			'function baz {\n\tsay hi\n}',
		)
		assert.ok(symbols.global[VANILLA_FUNCTION_CATEGORY]?.['foo:bar/baz'])
	})

	it('links a function call to its definition and back', () => {
		const symbols = bind(
			'file:///pack/src/main.mcb',
			'function caller {\n\tfunction ./callee\n}\nfunction callee {\n\tsay hi\n}',
		)
		const symbol = symbols.global[VANILLA_FUNCTION_CATEGORY]?.['main:callee']
		assert.ok(symbol, 'main:callee symbol should exist')
		assert.equal(symbol.definition?.length, 1)
		assert.equal(symbol.reference?.length, 1)
		assert.equal(symbol.definition?.[0].uri, 'file:///pack/src/main.mcb')
		assert.equal(symbol.reference?.[0].uri, 'file:///pack/src/main.mcb')
	})

	it('links schedule and tag-function references to the target function', () => {
		const symbols = bind(
			'file:///pack/src/main.mcb',
			'function tick {\n\tschedule function ./tick 1t\n}\n'
				+ 'tag function minecraft:tick {\n\t./tick\n}',
		)
		assert.equal(symbols.global[VANILLA_FUNCTION_CATEGORY]?.['main:tick']?.reference?.length, 2)
	})

	it('defines a clock as a function and links the calls inside it', () => {
		const symbols = bind(
			'file:///pack/src/main.mcb',
			'dir d {\n\tclock loop 1t {\n\t\tfunction ./callee\n\t}\n\tfunction callee {\n\t}\n}',
		)
		assert.equal(
			symbols.global[VANILLA_FUNCTION_CATEGORY]?.['main:d/loop']?.definition?.length,
			1,
		)
		assert.equal(
			symbols.global[VANILLA_FUNCTION_CATEGORY]?.['main:d/callee']?.reference?.length,
			1,
		)
	})

	it('links `^N` to the enclosing named function, skipping generated frames', () => {
		const symbols = bind(
			'file:///pack/src/main.mcb',
			'function loop {\n\tfunction ^0\n\texecute as @a run {\n\t\tfunction ^1\n\t\tfunction ^0\n\t}\n}',
		)
		assert.equal(symbols.global[VANILLA_FUNCTION_CATEGORY]?.['main:loop']?.reference?.length, 2)
	})

	it('leaves build-time targets unlinked', () => {
		const symbols = bind(
			'file:///pack/src/main.mcb',
			'function t {\n\tfunction ./a_<%i%>\n}',
		)
		assert.deepEqual(Object.keys(symbols.global[VANILLA_FUNCTION_CATEGORY] ?? {}), ['main:t'])
	})
})

const ref = (scheme: ReferenceNode['scheme'], path: string): ReferenceNode => ({
	type: 'mcbuild:reference',
	range: core.Range.create(0),
	scheme,
	isTag: false,
	path,
})

describe('mcbuild binder — reference resolution', () => {
	it('derives namespace + base path from a src/ URI', () => {
		assert.deepEqual(fileBase('file:///pack/src/main.mcb'), { namespace: 'main', path: [] })
		assert.deepEqual(fileBase('file:///pack/src/foo/bar.mcb'), {
			namespace: 'foo',
			path: ['bar'],
		})
		assert.equal(fileBase('file:///pack/data/x/y.mcb'), undefined)
	})

	it('mirrors evaluateFunctionHandle for each reference scheme', () => {
		const base = { namespace: 'main', path: [] as string[] }
		assert.equal(resolveFunctionId(ref('relative', './dummy'), base, []), 'main:dummy')
		assert.equal(resolveFunctionId(ref('relative', 'dummy'), base, []), 'main:dummy')
		assert.equal(resolveFunctionId(ref('relative', '../a'), base, ['sub']), 'main:a')
		assert.equal(resolveFunctionId(ref('relative', '../x'), base, []), undefined)
		assert.equal(resolveFunctionId(ref('absolute', 'a/b'), base, []), 'main:a/b')
		assert.equal(resolveFunctionId(ref('id', 'foo:bar/baz'), base, []), 'foo:bar/baz')
		assert.equal(resolveFunctionId(ref('parent', ''), base, []), undefined)
	})

	it('resolves relative refs against the dir + file base', () => {
		const base = { namespace: 'foo', path: ['bar'] }
		assert.equal(resolveFunctionId(ref('relative', './x'), base, ['d']), 'foo:bar/d/x')
	})

	it('returns undefined for a target that collapses to nothing (incomplete `./`)', () => {
		const base = { namespace: 'main', path: [] as string[] }
		assert.equal(resolveFunctionId(ref('relative', './'), base, []), undefined)
		assert.equal(resolveFunctionId(ref('relative', '.'), base, []), undefined)
		assert.equal(resolveFunctionId(ref('absolute', ''), base, []), undefined)
		assert.equal(resolveFunctionId(ref('id', 'nocolon'), base, []), undefined)
	})
})
