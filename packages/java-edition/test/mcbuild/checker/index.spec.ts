import {
	BinderContext,
	CheckerContext,
	Failure,
	Logger,
	MetaRegistry,
	ParserContext,
	Source,
} from '@spyglassmc/core'
import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { register as registerBinder } from '@spyglassmc/java-edition/lib/mcbuild/binder/index.js'
import { register as registerChecker } from '@spyglassmc/java-edition/lib/mcbuild/checker/index.js'
import { relativeSpec, resolveImport } from '@spyglassmc/java-edition/lib/mcbuild/imports.js'
import { entry } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { realArgument, tree } from '../parser/utils.ts'

const mcbEntry = entry({ tree, argument: realArgument, commandOptions: {} })

function makeProject() {
	const meta = new MetaRegistry()
	registerBinder(meta)
	registerChecker(meta)
	return mockProjectData({ meta, logger: Logger.create() })
}

function parseAndBind(
	project: ReturnType<typeof mockProjectData>,
	uri: string,
	content: string,
): core.AstNode {
	const doc = TextDocument.create(uri, 'mcbuild', 0, content)
	const node = mcbEntry(new Source(content), ParserContext.create(project, { doc }))
	if (node === Failure) {
		throw new Error(`parse failed for ${uri}`)
	}
	core.AstNode.setParents(node)
	const binder = project.meta.getBinder(node.type)
	void binder(node, BinderContext.create(project, { doc }))
	return node
}

async function check(content: string, uri = 'file:///pack/data/p/test.mcb') {
	const project = makeProject()
	const doc = TextDocument.create(uri, 'mcbuild', 0, content)
	const node = parseAndBind(project, uri, content)
	const ctx = CheckerContext.create(project, { doc })
	await core.checker.fallback(node, ctx)
	return ctx.err.dump()
}

describe('mcbuild checker — embedded JS', () => {
	it('does not flag free identifiers in an inline JS block (globals are dynamic)', async () => {
		const errors = await check('function t {\n\tsay <%mysteryVar%>\n}')
		assert.deepEqual(errors, [])
	})

	it('does not flag free identifiers or member assignments in a script block', async () => {
		const errors = await check(
			'function t {\n\t<%%\n\temit("say hi");\n\tstore.foo = config.bar;\n\t%%>\n}',
		)
		assert.deepEqual(errors, [])
	})
})

describe('mcbuild checker — template calls', () => {
	async function checkMain(
		templates: string,
		main: string,
	): Promise<readonly core.LanguageError[]> {
		const project = makeProject()
		parseAndBind(project, 'file:///pack/src/templates.mcbt', templates)
		const mainUri = 'file:///pack/src/main.mcb'
		const node = parseAndBind(project, mainUri, main)
		const ctx = CheckerContext.create(project, {
			doc: TextDocument.create(mainUri, 'mcbuild', 0, main),
		})
		await core.checker.fallback(node, ctx)
		return ctx.err.dump()
	}

	it('resolves an imported template call and does not flag it as an unknown command', async () => {
		const errors = await checkMain(
			'template greet {\n\twith {\n\t\tsay hi\n\t}\n}',
			'import ./templates.mcbt\nfunction t {\n\tgreet\n}',
		)
		assert.deepEqual(errors.map((e: core.LanguageError) => e.message), [])
	})

	it('resolves an imported template block-argument call', async () => {
		const errors = await checkMain(
			'template wrap {\n\twith content:block {\n\t\tsay wrapped\n\t}\n}',
			'import ./templates.mcbt\nfunction t {\n\twrap {\n\t\tsay inner\n\t}\n}',
		)
		assert.deepEqual(errors.map((e: core.LanguageError) => e.message), [])
	})

	it('warns on a template call with the wrong number of arguments', async () => {
		const errors = await checkMain(
			'template add {\n\twith a:int b:int {\n\t\tsay <%a%>\n\t}\n}',
			'import ./templates.mcbt\nfunction t {\n\tadd 1 2 3\n}',
		)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /add/)
	})

	const T = 'template t {\n'
		+ '\twith n:int {\n\t\tsay a\n\t}\n'
		+ '\twith j:js {\n\t\tsay d\n\t}\n'
		+ '\twith b:block {\n\t\tsay e\n\t}\n'
		+ '\twith mode:word rest:raw {\n\t\tsay f\n\t}\n'
		+ '\twith on {\n\t\tsay g\n\t}\n'
		+ '}'
	const call = (line: string) =>
		checkMain(T, `import ./templates.mcbt\nfunction fn {\n\t${line}\n}`)

	it('accepts arguments that match a param type', async () => {
		for (
			const line of ['t 5', 't -12', 't <%1%>', 't { say x }', 't append a b c', 't on']
		) {
			assert.deepEqual((await call(line)).map((e) => e.message), [], `for: ${line}`)
		}
	})

	it('rejects a non-numeric argument for an int param', async () => {
		const errors = await call('t notanumber')
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /No overload/)
	})

	it('rejects a plain word where a js param is required', async () => {
		const errors = await call('t plainword')
		assert.equal(errors.length, 1)
	})

	it('rejects a trailing block where no overload takes one', async () => {
		const errors = await checkMain(
			'template noblock {\n\twith n:int {\n\t\tsay a\n\t}\n}',
			'import ./templates.mcbt\nfunction fn {\n\tnoblock 5 {\n\t\tsay x\n\t}\n}',
		)
		assert.equal(errors.length, 1)
		assert.match(errors[0].message, /No overload/)
	})

	it('accepts a js span for an int param (runtime value cannot be checked)', async () => {
		assert.deepEqual((await call('t <%40 + 2%>')).map((e) => e.message), [])
	})
})

describe('mcbuild resolveImport()', () => {
	const from = 'file:///ws/pack/src/ns/main.mcb'

	it('resolves `/` from the mc-build project dir', () => {
		assert.deepEqual(resolveImport('/lib/t.mcbt', from, ['file:///ws/']), [
			'file:///ws/pack/lib/t.mcbt',
		])
	})

	it('resolves relative paths from the importing file', () => {
		assert.deepEqual(resolveImport('../t.mcbt', from, []), ['file:///ws/pack/src/t.mcbt'])
		assert.deepEqual(resolveImport('t.mcbt', from, []), ['file:///ws/pack/src/ns/t.mcbt'])
	})

	it('falls back to each root outside `src/`', () => {
		assert.deepEqual(resolveImport('/t.mcbt', 'file:///ws/a.mcb', ['file:///ws/', 'file:///x']), [
			'file:///ws/t.mcbt',
			'file:///x/t.mcbt',
		])
	})
})

describe('mcbuild relativeSpec()', () => {
	it('spells imports the way mc-build resolves them', () => {
		const from = 'file:///p/src/ns/main.mcb'
		assert.equal(relativeSpec(from, 'file:///p/src/ns/t.mcbt'), './t.mcbt')
		assert.equal(relativeSpec(from, 'file:///p/src/lib/t.mcbt'), '../lib/t.mcbt')
		assert.equal(relativeSpec(from, 'file:///p/src/ns/a/t.mcbt'), './a/t.mcbt')
	})
})
