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
	FUNCTION_CATEGORY,
	getTemplateData,
	register as registerBinder,
	TEMPLATE_CATEGORY,
} from '@spyglassmc/java-edition/lib/mcbuild/binder/index.js'
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

	it('registers dir-scoped function paths', () => {
		const symbols = bind(
			'file:///pack/data/p/main.mcb',
			'dir features {\n\tfunction spawn {\n\t\tsay hi\n\t}\n}\nfunction root {\n}',
		)
		const fns = Object.keys(symbols.global[FUNCTION_CATEGORY] ?? {}).sort()
		assert.deepEqual(fns, ['features/spawn', 'root'])
	})
})
