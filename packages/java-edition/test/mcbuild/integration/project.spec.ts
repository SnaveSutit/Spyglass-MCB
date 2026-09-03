import type {
	Externals,
	FileWatcher,
	FileWatcherEventMap,
	PosRangeLanguageError,
	ProjectInitializer,
	RootUriString,
} from '@spyglassmc/core'
import {
	completer as coreCompleter,
	CompleterContext,
	ConfigService,
	EventDispatcher,
	fileUtil,
	Logger,
	Project,
	UriStore,
	VanillaConfig,
} from '@spyglassmc/core'
import { getNodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import { register as registerBinder } from '@spyglassmc/java-edition/lib/mcbuild/binder/index.js'
import { register as registerChecker } from '@spyglassmc/java-edition/lib/mcbuild/checker/index.js'
import {
	entry as mcbCompleter,
	register as registerCompleter,
} from '@spyglassmc/java-edition/lib/mcbuild/completer/index.js'
import { entry } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import { argument } from '@spyglassmc/java-edition/lib/mcfunction/parser/index.js'
import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import { tree } from '../parser/utils.ts'

const CacheRoot: RootUriString = 'file:///cache/'
const ProjectRoot: RootUriString = 'file:///root/'

/** A file watcher that only reports the initial scan. */
class TestFileWatcher extends EventDispatcher<FileWatcherEventMap> implements FileWatcher {
	readonly #watchedFiles = new UriStore()
	readonly #externals: Externals
	readonly #locations: readonly RootUriString[]
	constructor(externals: Externals, locations: readonly RootUriString[]) {
		super()
		this.#externals = externals
		this.#locations = locations
	}
	get watchedFiles(): UriStore {
		return this.#watchedFiles
	}
	async ready(): Promise<void> {
		for (const location of this.#locations) {
			for (const uri of await fileUtil.getAllFiles(this.#externals, location)) {
				this.#watchedFiles.add(uri)
			}
		}
		this.emit('ready', undefined)
	}
	async close(): Promise<void> {}
}

/** Just the mc-build pieces, skipping the network-bound java-edition initializer. */
const mcbuildInitializer: ProjectInitializer = ({ meta }) => {
	const parser = entry({ tree, argument, commandOptions: {} })
	meta.registerLanguage('mc-build', { extensions: ['.mcb'], parser, completer: mcbCompleter })
	meta.registerLanguage('mc-build-template', {
		extensions: ['.mcbt'],
		parser,
		completer: mcbCompleter,
	})
	meta.registerCompleter('mcfunction:command', () => [])
	registerBinder(meta)
	registerChecker(meta)
	registerCompleter(meta)
	return { loadedVersion: '1.21' }
}

interface Harness {
	project: Project
	errors: Map<string, readonly PosRangeLanguageError[]>
}

async function setup(files: Record<string, string>): Promise<Harness> {
	const { fs } = memfs(files, '/')
	const externals = getNodeJsExternals({
		cacheRoot: CacheRoot,
		logger: Logger.noop(),
		nodeFsp: fs.promises as unknown as typeof fsp,
	})
	const project = new Project({
		cacheRoot: CacheRoot,
		defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
		externals,
		initializers: [mcbuildInitializer],
		logger: Logger.noop(),
		projectRoots: [ProjectRoot],
	})
	const errors = new Map<string, readonly PosRangeLanguageError[]>()
	project.on('documentErrored', ({ uri, errors: e }) => errors.set(uri, e))
	project.on('documentUpdated', ({ doc }) => {
		if (!errors.has(doc.uri)) {
			errors.set(doc.uri, [])
		}
	})
	await project.init()
	await project.ready({ projectRootsWatcher: new TestFileWatcher(externals, [ProjectRoot]) })
	return { project, errors }
}

function messagesFor(errors: Harness['errors'], uri: string): string[] {
	return (errors.get(uri) ?? []).map((e) => e.message)
}

describe('mcbuild integration (real Project pipeline)', () => {
	it('resolves a template call across an import, both file orderings', async () => {
		const main = 'import ./templates.mcbt\nfunction demo {\n\tgreet\n\tgreet_name hello\n}\n'
		const templates = 'template greet {\n\twith {\n\t\tsay hi\n\t}\n}\n'
			+ 'template greet_name {\n\twith name:raw {\n\t\tsay hi <%name%>\n\t}\n}\n'
		const { project, errors } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/main.mcb': main,
			'/root/src/templates.mcbt': templates,
		})
		try {
			await project.analyzeProject()
			assert.deepEqual(messagesFor(errors, `${ProjectRoot}src/main.mcb`), [])
			assert.deepEqual(messagesFor(errors, `${ProjectRoot}src/templates.mcbt`), [])
		} finally {
			await project.close()
		}
	})

	it('re-checks the caller after a template is added to an imported file', async () => {
		const mainUri = `${ProjectRoot}src/main.mcb`
		const templatesUri = `${ProjectRoot}src/templates.mcbt`
		const { project, errors } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/main.mcb':
				'import ./templates.mcbt\nfunction demo {\n\twrap {\n\t\tsay body\n\t}\n}\n',
			'/root/src/templates.mcbt': '# empty\n',
		})
		try {
			await project.analyzeProject()
			// Not a template yet; define it and re-analyze.
			await project.onDidChange(
				templatesUri,
				[{ text: 'template wrap {\n\twith content:block {\n\t\tsay wrapped\n\t}\n}\n' }],
				1,
			)
			await project.analyzeProject()
			assert.deepEqual(messagesFor(errors, mainUri), [])
		} finally {
			await project.close()
		}
	})

	it('flags a template call with the wrong argument count through the pipeline', async () => {
		const mainUri = `${ProjectRoot}src/main.mcb`
		const { project, errors } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/main.mcb': 'import ./t.mcbt\nfunction demo {\n\tadd 1 2 3\n}\n',
			'/root/src/t.mcbt': 'template add {\n\twith a:int b:int {\n\t\tsay <%a%>\n\t}\n}\n',
		})
		try {
			await project.analyzeProject()
			const msgs = messagesFor(errors, mainUri)
			assert.ok(
				msgs.some((m) => /add/.test(m)),
				`expected an "add" arg-count diagnostic, got ${JSON.stringify(msgs)}`,
			)
		} finally {
			await project.close()
		}
	})

	it('type-checks template arguments through the pipeline', async () => {
		const mainUri = `${ProjectRoot}src/main.mcb`
		const { project, errors } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/t.mcbt': 'template pos {\n\twith x:int y:int z:int {\n\t\tsay <%x%>\n\t}\n}\n'
				+ 'template wrap {\n\twith content:block {\n\t\tsay w\n\t}\n}\n',
			'/root/src/main.mcb': 'import ./t.mcbt\n'
				+ 'function ok {\n\tpos 1 2 3\n\tpos <%1%> -5 <%3%>\n\twrap {\n\t\tsay body\n\t}\n}\n'
				+ 'function bad {\n\tpos 1 two 3\n\twrap nope\n}\n',
		})
		try {
			await project.analyzeProject()
			const msgs = messagesFor(errors, mainUri)
			assert.equal(
				msgs.filter((m) => /No overload/.test(m)).length,
				2,
				JSON.stringify(msgs),
			)
		} finally {
			await project.close()
		}
	})

	it('parses and checks a standalone .mcb file with no imports', async () => {
		const uri = `${ProjectRoot}src/solo.mcb`
		const { project, errors } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/solo.mcb': 'function t {\n\tsay hello\n\teq a b = c d + 1\n}\n',
		})
		try {
			await project.analyzeProject()
			assert.deepEqual(messagesFor(errors, uri), [])
		} finally {
			await project.close()
		}
	})

	it('links function calls to their definition across files (go-to-definition / find-references)', async () => {
		const aUri = `${ProjectRoot}src/a.mcb`
		const bUri = `${ProjectRoot}src/b.mcb`
		const { project } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/a.mcb': 'function foo {\n\tsay hi\n}\n',
			'/root/src/b.mcb': 'function bar {\n\tfunction a:foo\n\tfunction ./local\n}\n'
				+ 'function local {\n\tsay x\n}\n',
		})
		try {
			await project.analyzeProject()
			const fns = project.symbols.global['mcbuild/function'] ?? {}

			const foo = fns['a:foo']
			assert.ok(foo, 'a:foo symbol should exist')
			assert.equal(foo.definition?.length, 1)
			assert.equal(foo.definition?.[0].uri, aUri)
			assert.equal(foo.reference?.length, 1)
			assert.equal(foo.reference?.[0].uri, bUri)

			const local = fns['b:local']
			assert.equal(local?.definition?.[0].uri, bUri)
			assert.equal(local?.reference?.[0].uri, bUri)
		} finally {
			await project.close()
		}
	})

	it('completes statement keywords + imported templates via the real completer pipeline', async () => {
		const mainUri = `${ProjectRoot}src/main.mcb`
		const before = 'import ./t.mcbt\nfunction demo {\n\t'
		const main = before + '\n}\n'
		const { project } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/t.mcbt': 'template greet {\n\twith {\n\t\tsay hi\n\t}\n}\n',
			'/root/src/main.mcb': main,
		})
		try {
			await project.analyzeProject()
			await project.onDidOpen(mainUri, 'mc-build', 1, main)
			const docAndNode = await project.ensureClientManagedChecked(mainUri)
			assert.ok(docAndNode)
			const items = coreCompleter.file(
				docAndNode.node,
				CompleterContext.create(project as never, {
					doc: docAndNode.doc,
					offset: before.length,
				}),
			)
			const labels = items.map((i) => i.label)
			assert.ok(labels.includes('schedule'), JSON.stringify(labels))
			assert.ok(labels.includes('execute'))
			assert.ok(labels.includes('greet'), 'imported template should be offered')
		} finally {
			await project.close()
		}
	})
})
