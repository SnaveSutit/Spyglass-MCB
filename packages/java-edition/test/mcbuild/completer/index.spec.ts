import {
	BinderContext,
	CompleterContext,
	Failure,
	Logger,
	MetaRegistry,
	ParserContext,
	Source,
} from '@spyglassmc/core'
import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { register as registerBinder } from '@spyglassmc/java-edition/lib/mcbuild/binder/index.js'
import { entry as complete } from '@spyglassmc/java-edition/lib/mcbuild/completer/index.js'
import { entry as parse } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { realArgument, tree } from '../parser/utils.ts'

const parser = parse({ tree, argument: realArgument, commandOptions: {} })

/** Completes at the `|` in `content`; `extraFiles` are bound first. */
function completeAt(
	content: string,
	uri = 'file:///pack/src/main.mcb',
	extraFiles: Record<string, string> = {},
): string[] {
	const offset = content.indexOf('|')
	assert.notEqual(offset, -1, 'content must contain a `|` cursor marker')
	const text = content.slice(0, offset) + content.slice(offset + 1)

	const meta = new MetaRegistry()
	registerBinder(meta)
	// A no-op mock-node getter is fine; we only assert on keyword / template items.
	meta.registerCompleter('mcfunction:command', () => [])
	const project = mockProjectData({ meta, logger: Logger.create() })

	const bindOne = (u: string, c: string) => {
		const doc = TextDocument.create(u, 'mc-build', 0, c)
		const node = parser(new Source(c), ParserContext.create(project, { doc }))
		if (node === Failure) {
			throw new Error(`parse failed for ${u}`)
		}
		core.AstNode.setParents(node)
		void meta.getBinder(node.type)(node, BinderContext.create(project, { doc }))
		return node
	}
	for (const [u, c] of Object.entries(extraFiles)) {
		bindOne(u, c)
	}
	const doc = TextDocument.create(uri, 'mc-build', 0, text)
	const node = bindOne(uri, text)

	const ctx = CompleterContext.create(project, { doc, offset })
	return complete(node, ctx).map((i) => i.label)
}

describe('mc-build completer', () => {
	it('offers statement keywords at the start of a fresh line in a function body', () => {
		const labels = completeAt('function t {\n\t|\n}')
		for (
			const kw of [
				'function',
				'schedule',
				'execute',
				'block',
				'return run',
				'eq',
				'IF',
				'REPEAT',
			]
		) {
			assert.ok(labels.includes(kw), `expected "${kw}", got ${JSON.stringify(labels)}`)
		}
	})

	it('offers a partially-typed statement keyword', () => {
		const labels = completeAt('function t {\n\tsch|\n}')
		assert.ok(labels.includes('schedule'))
	})

	it('offers in-scope template names in a function body', () => {
		const labels = completeAt(
			'import ./t.mcbt\nfunction t {\n\t|\n}',
			'file:///pack/src/main.mcb',
			{ 'file:///pack/src/t.mcbt': 'template greet {\n\twith {\n\t\tsay hi\n\t}\n}\n' },
		)
		assert.ok(labels.includes('greet'), `got ${JSON.stringify(labels)}`)
	})

	it('offers top-level keywords at the start of a .mcb file', () => {
		const labels = completeAt('|', 'file:///pack/src/main.mcb')
		for (const kw of ['function', 'dir', 'clock', 'import', 'tag', 'loot_table', 'worldgen']) {
			assert.ok(labels.includes(kw), `expected "${kw}", got ${JSON.stringify(labels)}`)
		}
		assert.ok(!labels.includes('template'))
	})

	it('offers .mcbt top-level keywords', () => {
		const labels = completeAt('|', 'file:///pack/src/t.mcbt')
		assert.deepEqual(labels.sort(), ['import', 'template'])
	})

	it('offers with / load / tick inside a template', () => {
		const labels = completeAt('template t {\n\t|\n}', 'file:///pack/src/t.mcbt')
		assert.deepEqual(labels.sort(), ['load', 'tick', 'with'])
	})

	it('offers reference prefixes and function ids after `function `', () => {
		const labels = completeAt('function t {\n\tfunction |\n}')
		assert.ok(labels.includes('./'))
		assert.ok(labels.includes('#'))
		assert.ok(labels.includes('^0'))
	})

	const REFS = 'function alpha {\n\tsay a\n}\n'
		+ 'dir folder {\n\tfunction beta {\n\t\tsay b\n\t}\n\tfunction caller {\n\t\tXX\n\t}\n}\n'

	it('offers `./`-relative spellings anchored at the current dir', () => {
		const labels = completeAt(REFS.replace('XX', 'function ./|'))
		assert.deepEqual(labels.sort(), ['./beta', './caller'])
	})

	it('offers `../` spellings that actually climb out of the current dir', () => {
		const labels = completeAt(REFS.replace('XX', 'function ../|'))
		assert.deepEqual(labels, ['../alpha'])
	})

	it('offers `*` project-absolute spellings for same-namespace functions', () => {
		const labels = completeAt(REFS.replace('XX', 'function *|'))
		assert.deepEqual(labels.sort(), ['*alpha', '*folder/beta', '*folder/caller'])
	})

	it('filters fully-qualified ids by the typed namespace prefix', () => {
		const labels = completeAt(REFS.replace('XX', 'function main:|'))
		assert.ok(labels.every((l) => l.startsWith('main:')))
		assert.ok(labels.includes('main:alpha'))
	})

	it('completes relative spellings for `schedule function` targets', () => {
		const labels = completeAt(REFS.replace('XX', 'schedule function ./|'))
		assert.deepEqual(labels.sort(), ['./beta', './caller'])
	})

	it('offers schedule sub-keywords after `schedule `', () => {
		const labels = completeAt('function t {\n\tschedule |\n}')
		assert.ok(labels.includes('function'))
		assert.ok(labels.includes('clear'))
		assert.ok(labels.includes('1t'))
	})

	it('offers tag registries after `tag `', () => {
		const labels = completeAt('tag |', 'file:///pack/src/main.mcb')
		assert.ok(labels.includes('function'))
		assert.ok(labels.includes('block'))
	})

	it('offers import path prefixes', () => {
		const labels = completeAt('import |', 'file:///pack/src/main.mcb')
		assert.deepEqual(labels.sort(), ['./', '/'])
	})

	it('does not offer keywords once a command line has arguments', () => {
		const labels = completeAt('function t {\n\tsay hello |\n}')
		assert.ok(!labels.includes('schedule'))
		assert.ok(!labels.includes('execute'))
	})
})
