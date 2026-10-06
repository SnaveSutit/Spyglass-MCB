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
import { entry as parse } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { realArgument, tree } from './utils.ts'

/**
 * Real mc-build packs must produce no `mcbuild.*` diagnostics. Packs are found
 * next to this checkout (skipped if absent); add more via `MCB_EXTRA_PACKS`
 * (`:`-separated `src/` dirs).
 */

/** Every `mcbuild.*` locale message as a regex. */
const enLocale = JSON.parse(
	fs.readFileSync(
		path.resolve(import.meta.dirname, '../../../../locales/src/locales/en.json'),
		'utf8',
	),
) as Record<string, string>
const MCBUILD_MESSAGE_RES = Object.entries(enLocale)
	.filter(([key]) => key.startsWith('mcbuild.'))
	.map(([, value]) =>
		new RegExp(
			'^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%\d+%/g, '.*?') + '$',
		)
	)
function isMcbuildDiagnostic(message: string): boolean {
	return MCBUILD_MESSAGE_RES.some((re) => re.test(message))
}

interface Pack {
	name: string
	srcDir: string
}

function discoverPacks(): Pack[] {
	const packs: Pack[] = []

	// mc-build's own fixture packs.
	for (
		const rel of [
			'../../../../../../mc-build/mcb/tests',
			'../../../../../../../mc-build/mcb/tests',
		]
	) {
		const dir = process.env['MCB_REPO']
			? path.join(process.env['MCB_REPO'], 'tests')
			: path.resolve(import.meta.dirname, rel)
		if (!fs.existsSync(dir)) {
			continue
		}
		for (const fixture of fs.readdirSync(dir)) {
			const src = path.join(dir, fixture, 'source')
			if (fs.existsSync(src)) {
				packs.push({ name: `mc-build/${fixture}`, srcDir: src })
			}
		}
		break
	}

	// Larger real packs kept alongside this checkout.
	for (
		const rel of [
			'../../../../../../aj-booth-smithed-summit-2026/datapacks/aj_booth/src',
			'../../../../../../../aj-booth-smithed-summit-2026/datapacks/aj_booth/src',
		]
	) {
		const dir = path.resolve(import.meta.dirname, rel)
		if (fs.existsSync(dir)) {
			packs.push({ name: 'aj-booth/aj_booth', srcDir: dir })
			break
		}
	}

	for (const extra of (process.env['MCB_EXTRA_PACKS'] ?? '').split(':').filter(Boolean)) {
		if (fs.existsSync(extra)) {
			packs.push({ name: path.basename(path.dirname(extra)), srcDir: extra })
		}
	}
	return packs
}

function listMcbFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			out.push(...listMcbFiles(full))
		} else if (entry.name.endsWith('.mcb') || entry.name.endsWith('.mcbt')) {
			out.push(full)
		}
	}
	return out
}

const packs = discoverPacks()

describe('mcbuild real-pack diagnostics', {
	skip: packs.length === 0 ? 'no mc-build packs found next to this checkout' : false,
}, () => {
	for (const pack of packs) {
		it(`${pack.name} produces no mcbuild-layer diagnostics`, async () => {
			const meta = new MetaRegistry()
			registerBinder(meta)
			registerChecker(meta)
			meta.registerChecker('mcfunction:command', () => {})
			const project = mockProjectData({
				meta,
				logger: Logger.create(),
				ctx: { loadedVersion: '1.21' },
				// mc-build's `/` imports resolve from here when there's no `src/`.
				roots: [`file://${pack.srcDir.replace(/\/$/, '')}/`],
			})
			const mcbParser = parse({ tree, argument: realArgument, commandOptions: {} })

			const files = listMcbFiles(pack.srcDir)
			const parsed: { uri: string; content: string; node: core.AstNode }[] = []
			for (const file of files) {
				const content = fs.readFileSync(file, 'utf8')
				const uri = `file://${file}`
				const doc = TextDocument.create(uri, 'mc-build', 0, content)
				const node = mcbParser(new Source(content), ParserContext.create(project, { doc }))
				if (node === Failure) {
					throw new Error(`parse failed for ${file}`)
				}
				core.AstNode.setParents(node)
				void meta.getBinder(node.type)(node, BinderContext.create(project, { doc }))
				parsed.push({ uri, content, node })
			}

			const problems: string[] = []
			for (const { uri, content, node } of parsed) {
				const doc = TextDocument.create(uri, 'mc-build', 0, content)
				const parserCtx = ParserContext.create(project, { doc })
				mcbParser(new Source(content), parserCtx)
				const checkerCtx = CheckerContext.create(project, { doc })
				await core.checker.fallback(node, checkerCtx)

				for (const e of [...parserCtx.err.dump(), ...checkerCtx.err.dump()]) {
					if (isMcbuildDiagnostic(e.message)) {
						const line = content.slice(0, e.range.start).split('\n').length
						problems.push(`  ${uri.split('/').pop()}:${line}  ${e.message}`)
					}
				}
			}

			if (problems.length > 0) {
				throw new Error(
					`Unexpected mcbuild-layer diagnostics in ${pack.name}:\n${problems.join('\n')}`,
				)
			}
		})
	}
})
