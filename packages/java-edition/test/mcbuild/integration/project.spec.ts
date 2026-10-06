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
	Service,
	UriStore,
	VanillaConfig,
} from '@spyglassmc/core'
import { getNodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import { registerUriBuilders, uriBinder } from '@spyglassmc/java-edition/lib/binder/index.js'
import { register as registerBinder } from '@spyglassmc/java-edition/lib/mcbuild/binder/index.js'
import { register as registerChecker } from '@spyglassmc/java-edition/lib/mcbuild/checker/index.js'
import { entry as mcbCompleterEntry } from '@spyglassmc/java-edition/lib/mcbuild/completer/index.js'
import { entry } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import { addFunction } from '@spyglassmc/java-edition/lib/mcbuild/quickFix.js'
import { templateSignatureHelp } from '@spyglassmc/java-edition/lib/mcbuild/signatureHelp.js'
import { getMockNodes } from '@spyglassmc/java-edition/lib/mcfunction/completer/index.js'
import { argument } from '@spyglassmc/java-edition/lib/mcfunction/parser/index.js'
import { signatureHelpProvider } from '@spyglassmc/java-edition/lib/mcfunction/signatureHelpProvider.js'
import * as mcf from '@spyglassmc/mcfunction'
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
	const completer = mcbCompleterEntry({
		command: mcf.completer.command(tree, getMockNodes),
	})
	meta.registerLanguage('mc-build', {
		extensions: ['.mcb'],
		parser,
		completer,
		recheckOnCrossFileChange: true,
	})
	meta.registerLanguage('mc-build-template', {
		extensions: ['.mcbt'],
		parser,
		completer,
		recheckOnCrossFileChange: true,
	})
	meta.registerLanguage('mcfunction', {
		extensions: ['.mcfunction'],
		parser: mcf.entry(tree, argument),
	})
	meta.registerUriBinder(uriBinder)
	registerUriBuilders(meta)
	meta.registerCompleter('mcfunction:command_child/literal', coreCompleter.literal)
	meta.registerGeneratedFolder('mcb.config.js', 'data')
	meta.registerUndeclaredSymbolAction('function', addFunction)
	meta.registerSignatureHelpProvider(templateSignatureHelp)
	registerBinder(meta)
	registerChecker(meta)
	meta.registerSignatureHelpProvider(signatureHelpProvider(tree as never))
	return { loadedVersion: '1.21' }
}

interface Harness {
	project: Service['project']
	service: Service
	errors: Map<string, readonly PosRangeLanguageError[]>
}

async function setup(files: Record<string, string>): Promise<Harness> {
	const { fs } = memfs(files, '/')
	const externals = getNodeJsExternals({
		cacheRoot: CacheRoot,
		logger: Logger.noop(),
		nodeFsp: fs.promises as unknown as typeof fsp,
	})
	const service = new Service({
		logger: Logger.noop(),
		project: {
			cacheRoot: CacheRoot,
			defaultConfig: ConfigService.merge(VanillaConfig, { env: { dependencies: [] } }),
			externals,
			initializers: [mcbuildInitializer],
			projectRoots: [ProjectRoot],
		},
	})
	const { project } = service
	const errors = new Map<string, readonly PosRangeLanguageError[]>()
	project.on('documentErrored', ({ uri, errors: e }) => errors.set(uri, e))
	project.on('documentUpdated', ({ doc }) => {
		if (!errors.has(doc.uri)) {
			errors.set(doc.uri, [])
		}
	})
	await project.init()
	await project.ready({ projectRootsWatcher: new TestFileWatcher(externals, [ProjectRoot]) })
	return { project, service, errors }
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

	it('re-checks an open caller after a template is added to an open imported file', async () => {
		const mainUri = `${ProjectRoot}src/main.mcb`
		const templatesUri = `${ProjectRoot}src/templates.mcbt`
		const main = 'import ./templates.mcbt\nfunction demo {\n\twrap {\n\t\tsay body\n\t}\n}\n'
		const { project, errors } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/main.mcb': main,
			'/root/src/templates.mcbt': '# empty\n',
		})
		try {
			await project.analyzeProject()
			await project.onDidOpen(mainUri, 'mc-build', 1, main)
			await project.onDidOpen(templatesUri, 'mc-build-template', 1, '# empty\n')
			await project.ensureClientManagedChecked(mainUri)
			assert.notDeepEqual(messagesFor(errors, mainUri), [], 'not a template yet')

			await project.onDidChange(
				templatesUri,
				[{ text: 'template wrap {\n\twith content:block {\n\t\tsay wrapped\n\t}\n}\n' }],
				2,
			)
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
			const fns = project.symbols.global['function'] ?? {}

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

	/** Completes at the `|` in file `open`. */
	async function completeInProject(
		files: Record<string, string>,
		open: string,
	): Promise<string[]> {
		const marked = files[open]
		const offset = marked.indexOf('|')
		assert.notEqual(offset, -1, 'a file must contain the `|` cursor marker')
		const clean = { ...files, [open]: marked.replace('|', '') }
		const openUri = `${ProjectRoot}${open.replace(/^\/root\//, '')}`
		const fsFiles = Object.fromEntries(
			Object.entries(clean).map(([k, v]) => [k.startsWith('/') ? k : `/root/${k}`, v]),
		)
		fsFiles['/root/pack.mcmeta'] = JSON.stringify({
			pack: { pack_format: 48, description: '' },
		})
		const { project } = await setup(fsFiles)
		try {
			await project.analyzeProject()
			const text = clean[open]
			await project.onDidOpen(openUri, 'mc-build', 1, text)
			const docAndNode = await project.ensureClientManagedChecked(openUri)
			assert.ok(docAndNode)
			const items = coreCompleter.file(
				docAndNode.node,
				CompleterContext.create(project as never, { doc: docAndNode.doc, offset }),
			)
			return items.map((i) => i.label)
		} finally {
			await project.close()
		}
	}

	it('completes `./` function-call targets from the same and sibling files', async () => {
		const labels = await completeInProject({
			'src/pack.mcb': 'function alpha {\n\tsay a\n}\nfunction caller {\n\tfunction ./|\n}\n',
			'src/pack/util.mcb': 'function beta {\n\tsay b\n}\n',
		}, 'src/pack.mcb')
		assert.deepEqual(labels.sort(), ['./alpha', './caller', './util/beta'])
	})

	it('completes `./` targets inside a dir block, anchored at the dir', async () => {
		const labels = await completeInProject({
			'src/main.mcb':
				'function root_fn {\n\tsay r\n}\ndir tools {\n\tfunction helper {\n\t\tsay h\n\t}\n\tfunction caller {\n\t\tfunction ./|\n\t}\n}\n',
		}, 'src/main.mcb')
		assert.deepEqual(labels.sort(), ['./caller', './helper'])
	})

	it('completes `./` targets inside an execute-run block and at end of file', async () => {
		const inExec = await completeInProject({
			'src/main.mcb':
				'function alpha {\n\tsay a\n}\nfunction caller {\n\texecute as @s run {\n\t\tfunction ./|\n\t}\n}\n',
		}, 'src/main.mcb')
		assert.deepEqual(inExec.sort(), ['./alpha', './caller'])

		const atEof = await completeInProject({
			'src/main.mcb': 'function alpha {\n\tsay a\n}\nfunction caller {\n\tfunction ./|',
		}, 'src/main.mcb')
		assert.deepEqual(atEof.sort(), ['./alpha', './caller'])
	})

	it('completes `../` and `*` targets by their reachable spelling', async () => {
		const up = await completeInProject({
			'src/main.mcb':
				'function alpha {\n\tsay a\n}\ndir d {\n\tfunction caller {\n\t\tfunction ../|\n\t}\n}\n',
		}, 'src/main.mcb')
		assert.deepEqual(up, ['../alpha'])

		const abs = await completeInProject({
			'src/main.mcb':
				'function alpha {\n\tsay a\n}\ndir d {\n\tfunction caller {\n\t\tfunction *|\n\t}\n}\n',
		}, 'src/main.mcb')
		assert.deepEqual(abs.sort(), ['*alpha', '*d/caller'])
	})

	it('completes vanilla commands inside a function body via the real pipeline', async () => {
		const fresh = await completeInProject({
			'src/main.mcb': 'function t {\n\t|\n}\n',
		}, 'src/main.mcb')
		assert.ok(fresh.includes('say'), JSON.stringify(fresh))
		assert.ok(fresh.includes('execute'), 'mc-build keywords still offered')

		const args = await completeInProject({
			'src/main.mcb': 'function t {\n\texecute |\n}\n',
		}, 'src/main.mcb')
		assert.deepEqual(args.sort(), ['as', 'at', 'if', 'run'])

		const inBlock = await completeInProject({
			'src/main.mcb': 'function t {\n\texecute as @s run {\n\t\tscoreb|\n\t}\n}\n',
		}, 'src/main.mcb')
		assert.ok(inBlock.includes('scoreboard'), JSON.stringify(inBlock))
	})

	/** Opens `main` (cursor marked by `|`) in a fresh project and returns the service, doc, node and offset. */
	async function openAt(main: string, extra: Record<string, string> = {}) {
		const offset = main.indexOf('|')
		const text = main.replace('|', '')
		const uri = `${ProjectRoot}src/main.mcb`
		const harness = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/main.mcb': text,
			...extra,
		})
		await harness.project.analyzeProject()
		await harness.project.onDidOpen(uri, 'mc-build', 1, text)
		const docAndNode = await harness.project.ensureClientManagedChecked(uri)
		assert.ok(docAndNode)
		return { ...harness, ...docAndNode, offset, uri }
	}

	it('reports vanilla command errors through the pipeline', async () => {
		const { project, errors, uri } = await openAt('function t {\n\tbogus cmd\n\tsay hi\n}\n|')
		try {
			assert.ok(
				messagesFor(errors, uri).some((m) => /Expected/.test(m)),
				JSON.stringify(messagesFor(errors, uri)),
			)
		} finally {
			await project.close()
		}
	})

	it('hovers and goes to definition from a template call', async () => {
		const { project, service, doc, node, offset } = await openAt(
			'import ./t.mcbt\nfunction t {\n\tgr|eet x\n}\n',
			{ '/root/src/t.mcbt': 'template greet {\n\twith n:word {\n\t\tsay <%n%>\n\t}\n}\n' },
		)
		try {
			assert.match(
				service.getHover(node, doc, offset)?.markdown ?? '',
				/mcbuild\/template\) greet/,
			)
			const defs = await service.getSymbolLocations(node, doc, offset, ['definition'])
			assert.deepEqual(defs?.locations?.map((l) => l.uri), [`${ProjectRoot}src/t.mcbt`])
		} finally {
			await project.close()
		}
	})

	it('offers vanilla command signature help inside a function body', async () => {
		const { project, service, doc, node, offset } = await openAt(
			'function t {\n\tscoreboard |\n}\n',
		)
		try {
			assert.ok(service.getSignatureHelp(node, doc, offset)?.signatures.length)
		} finally {
			await project.close()
		}
	})

	it('links calls between .mcfunction and .mcb files both ways', async () => {
		const { project } = await setup({
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/a.mcb': 'function foo {\n\tfunction a:vanilla\n}\n',
			'/root/data/a/function/vanilla.mcfunction': 'function a:foo\n',
		})
		try {
			await project.analyzeProject()
			const fns = project.symbols.global['function'] ?? {}
			assert.deepEqual(fns['a:foo']?.reference?.map((l) => l.uri), [
				`${ProjectRoot}data/a/function/vanilla.mcfunction`,
			])
			assert.deepEqual(fns['a:vanilla']?.reference?.map((l) => l.uri), [
				`${ProjectRoot}src/a.mcb`,
			])
			assert.ok(fns['a:vanilla']?.definition?.length, 'the .mcfunction file defines a:vanilla')
		} finally {
			await project.close()
		}
	})

	it('warns on calls to undeclared functions, but not build-time targets', async () => {
		const { project, errors, uri } = await openAt(
			'function t {\n\tfunction ./missing\n\tfunction ./t\n\tfunction ./x_<%i%>\n}\n|',
		)
		try {
			const msgs = messagesFor(errors, uri)
			assert.equal(msgs.length, 1, JSON.stringify(msgs))
			assert.match(msgs[0], /main:missing/)
		} finally {
			await project.close()
		}
	})

	it('indexes generated data/ files next to mcb.config.js without analyzing them', async () => {
		const generatedUri = `${ProjectRoot}data/a/function/gen.mcfunction`
		const files = {
			'/root/pack.mcmeta': JSON.stringify({ pack: { pack_format: 48, description: '' } }),
			'/root/src/a.mcb': 'function foo {\n\tfunction a:gen\n}\n',
			'/root/data/a/function/gen.mcfunction': 'not a command\n',
		}
		const generated = await setup({ ...files, '/root/mcb.config.js': 'module.exports = {}\n' })
		try {
			await generated.project.analyzeProject()
			assert.equal(generated.errors.get(generatedUri), undefined, 'never analyzed')
			assert.deepEqual(messagesFor(generated.errors, `${ProjectRoot}src/a.mcb`), [])
			assert.ok(generated.project.symbols.global['function']?.['a:gen']?.definition?.length)
		} finally {
			await generated.project.close()
		}

		const plain = await setup(files)
		try {
			await plain.project.analyzeProject()
			assert.notDeepEqual(
				messagesFor(plain.errors, generatedUri),
				[],
				'analyzed without the marker',
			)
		} finally {
			await plain.project.close()
		}
	})

	it('reports inline and block execute errors once, without a spurious one after `run`', async () => {
		const { project, errors, uri } = await openAt(
			'function t {\n\texecute as @a run say hi\n\texecute as @a run {\n\t\tsay hi\n\t}\n}\n|',
		)
		try {
			assert.deepEqual(messagesFor(errors, uri), [])
		} finally {
			await project.close()
		}
	})

	it('resolves the explicit `template <name>` call form', async () => {
		const { project, errors, uri } = await openAt(
			'import ./t.mcbt\nfunction t {\n\ttemplate greet\n\ttemplate nope\n}\n|',
			{ '/root/src/t.mcbt': 'template greet {\n\twith {\n\t\tsay hi\n\t}\n}\n' },
		)
		try {
			assert.deepEqual(messagesFor(errors, uri), ['Unknown template “nope”'])
		} finally {
			await project.close()
		}
	})

	it('links function tags across mc-build, JSON tags and appends', async () => {
		const { project, errors, uri } = await openAt(
			'function t a:appended {\n\tfunction #a:json\n\tfunction #a:appended\n\tfunction #a:missing\n}\n|',
			{
				'/root/data/a/tags/function/json.json': JSON.stringify({ values: ['a:t'] }),
			},
		)
		try {
			const tags = project.symbols.global['tag/function'] ?? {}
			assert.ok(tags['a:json']?.definition?.length, 'JSON tag file defines a:json')
			assert.equal(tags['a:json']?.reference?.length, 1)
			const msgs = messagesFor(errors, uri)
			assert.equal(msgs.length, 1, JSON.stringify(msgs))
			assert.match(msgs[0], /a:missing/)
		} finally {
			await project.close()
		}
	})

	it('offers to add missing functions and templates where mc-build would look', async () => {
		const { project, service, doc, node } = await openAt(
			'import ./t.mcbt\nfunction t {\n\tfunction ./d/missing\n\tfunction a:other/x\n\ttemplate nope\n}\n|',
			{ '/root/src/t.mcbt': '# templates\n' },
		)
		try {
			const actions = ['./d/missing', 'a:other/x', 'nope'].flatMap((needle) => {
				const offset = doc.getText().indexOf(needle) + 2
				return service.getCodeActions(node, doc, { start: offset, end: offset })
			})
			assert.deepEqual(actions.map((a) => [a.title, a.changes]), [
				['Add function “d/missing” to main.mcb', [
					{
						type: 'append',
						uri: `${ProjectRoot}src/main.mcb`,
						text: 'function d/missing {\n}\n',
					},
				]],
				['Add function “x” to other.mcb', [
					{ type: 'append', uri: `${ProjectRoot}src/a/other.mcb`, text: 'function x {\n}\n' },
				]],
				['Add template “nope” to t.mcbt', [{
					type: 'append',
					uri: `${ProjectRoot}src/t.mcbt`,
					text: 'template nope {\n\twith {\n\t}\n}\n',
				}]],
			])
		} finally {
			await project.close()
		}
	})

	describe('#> doc blocks', () => {
		const lib =
			'#> Says hi\n# @arg name {string} Who to greet\nfunction greet {\n\t$say hi $(name) $(nope)\n}\n'
			+ '#> Old\n# @deprecated Use ./greet\nfunction old {\n}\n'
			+ '# Not a doc block\nfunction plain {\n}\n'

		it('shows the doc on hover', async () => {
			const { project, service, doc, node, offset } = await openAt(
				'function t {\n\tfunction lib:gr|eet {name:"x"}\n}\n',
				{ '/root/src/lib.mcb': lib },
			)
			try {
				const hover = service.getHover(node, doc, offset)?.markdown ?? ''
				assert.match(hover, /Says hi/)
				assert.match(hover, /`name`: `string` — Who to greet/)
			} finally {
				await project.close()
			}
		})

		it('checks macro arguments and deprecation', async () => {
			const libUri = `${ProjectRoot}src/lib.mcb`
			const { project, errors, uri } = await openAt(
				'function t {\n\tfunction lib:greet {name:"x", extra:1}\n\tfunction lib:greet {}\n'
					+ '\tfunction lib:greet\n\tfunction lib:old\n\tfunction lib:plain\n}\n|',
				{ '/root/src/lib.mcb': lib },
			)
			try {
				assert.deepEqual(messagesFor(errors, uri), [
					'“lib:greet” has no macro argument “extra”',
					'Missing macro argument “name” for “lib:greet”',
					'“lib:greet” expects macro arguments: “name”',
					'“lib:old” is deprecated: Use ./greet',
				])
				assert.deepEqual(messagesFor(errors, libUri), [
					"Macro argument “nope” isn't declared with @arg",
				])
			} finally {
				await project.close()
			}
		})
	})

	describe('template signatures', () => {
		const templates = '#> Moves a score\n# @param target Who to move\ntemplate move {\n'
			+ '\twith target:word amount:int {\n\t\tsay a\n\t}\n'
			+ '\twith target:word rest:raw {\n\t\tsay b\n\t}\n}\n'

		it('lists overloads on hover', async () => {
			const { project, service, doc, node, offset } = await openAt(
				'import ./t.mcbt\nfunction t {\n\tmo|ve @s 1\n}\n',
				{ '/root/src/t.mcbt': templates },
			)
			try {
				const hover = service.getHover(node, doc, offset)?.markdown ?? ''
				assert.match(
					hover,
					/```mc-build\nmove target:word amount:int\nmove target:word rest:raw\n```/,
				)
				assert.match(hover, /`target` — Who to move/)
			} finally {
				await project.close()
			}
		})

		it('highlights the parameter being typed', async () => {
			const { project, service, doc, node, offset } = await openAt(
				'import ./t.mcbt\nfunction t {\n\tmove @s |\n}\n',
				{ '/root/src/t.mcbt': templates },
			)
			try {
				const help = service.getSignatureHelp(node, doc, offset)
				assert.deepEqual(
					help?.signatures.map((
						s,
					) => [s.label, s.activeParameter, s.parameters[0].documentation]),
					[
						['move target:word amount:int', 1, 'Who to move'],
						['move target:word rest:raw', 1, 'Who to move'],
					],
				)
				assert.equal(help?.signatures[0].documentation, 'Moves a score')
			} finally {
				await project.close()
			}
		})
	})

	describe('scripts', () => {
		it('flags REPEAT calls whose literal arguments fit no overload', async () => {
			const { project, errors, uri } = await openAt(
				'function t {\n\tREPEAT(1, 2, 3, 4) as i {\n\t\tsay <%i%>\n\t}\n'
					+ "\tREPEAT('a') as i {\n\t}\n\tREPEAT(-1, 1) as i {\n\t}\n"
					+ '\tREPEAT([1, 2]) as i {\n\t}\n\tREPEAT(config.n) as i {\n\t}\n}\n|',
			)
			try {
				assert.deepEqual(messagesFor(errors, uri), [
					'Invalid arguments for REPEAT (number, number, number, number)',
					'Invalid arguments for REPEAT (string)',
				])
			} finally {
				await project.close()
			}
		})

		it('completes globals, template params and loop variables', async () => {
			const labels = await completeInProject({
				'src/t.mcbt':
					'template t {\n\twith count:int {\n\t\tREPEAT(1, 2) as i {\n\t\t\tsay <%c|%>\n\t\t}\n\t}\n}\n',
			}, 'src/t.mcbt')
			for (const name of ['count', 'i', 'REPEAT', 'config', 'isMacro']) {
				assert.ok(labels.includes(name), `${name} in ${JSON.stringify(labels)}`)
			}
			assert.ok(!labels.includes('emit'), 'emit is only in <%% %%>')

			const fields = await completeInProject({
				'src/t.mcb': 'function t {\n\tsay <%config.|%>\n}\n',
			}, 'src/t.mcb')
			assert.ok(fields.includes('internalScoreboardName'), JSON.stringify(fields))
		})
	})

	describe('typed template params', () => {
		const templates = 'template move {\n'
			+ '\t#> Gives an item\n\t# @param item {resource:item}\n\t# @param n {nope}\n'
			+ '\twith give item:word n:int {\n\t\tsay <%item%>\n\t}\n'
			+ '\t#> Teleports somewhere\n\t# @param target {entity} Who\n\t# @param pos {vec3}\n'
			+ '\twith target:word pos:raw {\n\t\ttp <%target%> <%pos%>\n\t}\n}\n'

		it('checks arguments against @param types', async () => {
			const templatesUri = `${ProjectRoot}src/t.mcbt`
			const { project, errors, uri } = await openAt(
				'import ./t.mcbt\nfunction t {\n\tmove @s ~ ~ ~\n\tmove @s 1 2\n'
					+ '\tmove <%who%> 1 2 3\n\tmove give minecraft:stone 1\n\tmove give Stone! 1\n}\n|',
				{ '/root/src/t.mcbt': templates },
			)
			try {
				const msgs = messagesFor(errors, uri)
				assert.equal(msgs.length, 2, JSON.stringify(msgs))
				assert.match(msgs[0], /^“pos” should be vec3: /)
				assert.match(msgs[1], /^“item” should be resource:item: /)
				assert.deepEqual(messagesFor(errors, templatesUri), [
					'Unknown param type “nope”; expected a Minecraft argument type like entity, vec3 or resource:item',
				])
			} finally {
				await project.close()
			}
		})

		it("shows each overload's doc and param types in signature help", async () => {
			const { project, service, doc, node, offset } = await openAt(
				'import ./t.mcbt\nfunction t {\n\tmove |\n}\n',
				{ '/root/src/t.mcbt': templates },
			)
			try {
				const help = service.getSignatureHelp(node, doc, offset)
				assert.deepEqual(
					help?.signatures.map((s) => [s.documentation, s.parameters[0].documentation]),
					[['Gives an item', undefined], ['Teleports somewhere', '`entity` — Who']],
				)
			} finally {
				await project.close()
			}
		})
	})
})
