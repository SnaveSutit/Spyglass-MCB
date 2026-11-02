import * as core from '@spyglassmc/core'
import { CompletionItem, CompletionKind } from '@spyglassmc/core'
import { resolveImport } from './imports.js'

/** What mc-build can import: templates, and scripts/data merged into the file's JS scope. */
const IMPORTABLE = /\.(mcbt|[cm]?js|json)$/
const HIDDEN = /^(\.|node_modules$)/

/**
 * Completes `import` paths a folder at a time, listing the folder typed so far on disk. Covers
 * `.js`/`.json`, which Spyglass doesn't track.
 */
export const importCompletion: core.CompletionProvider = async (_node, ctx) => {
	if (!/\.mcbt?$/.test(ctx.doc.uri)) {
		return []
	}
	const text = ctx.doc.getText()
	const lineStart = text.lastIndexOf('\n', ctx.offset - 1) + 1
	const typed = /^\s*import\s+(\S*)$/.exec(text.slice(lineStart, ctx.offset))?.[1]
	if (typed === undefined) {
		return []
	}
	const slash = typed.lastIndexOf('/')
	const range = core.Range.create(ctx.offset - typed.length + slash + 1, ctx.offset)
	if (slash < 0) {
		return [
			folderItem('./', range, 'relative import'),
			folderItem('../', range, 'relative import'),
			folderItem('/', range, 'import from src/'),
		]
	}

	const folder = typed.slice(0, slash + 1)
	const imported = importedElsewhere(text, lineStart, ctx)
	const items = new Map<string, CompletionItem>()
	if (/^(\.\.\/)+$/.test(folder)) {
		items.set('../', folderItem('../', range, 'parent folder'))
	}
	for (const dir of resolveImport(folder, ctx.doc.uri, ctx.roots)) {
		for (const entry of await listDir(dir, ctx)) {
			if (HIDDEN.test(entry.name) || items.has(entry.name)) {
				continue
			}
			if (entry.isDirectory()) {
				items.set(entry.name, folderItem(`${entry.name}/`, range))
			} else if (IMPORTABLE.test(entry.name)) {
				const uri = new URL(encodeURIComponent(entry.name), dir).href
				if (uri !== ctx.doc.uri && !imported.has(uri)) {
					items.set(entry.name, fileItem(entry.name, range))
				}
			}
		}
	}
	return [...items.values()]
}

async function listDir(dir: string, ctx: core.CompleterContext) {
	try {
		return await ctx.externals.fs.readdir(dir)
	} catch {
		return []
	}
}

/** URIs imported by the file's other `import` lines. */
function importedElsewhere(text: string, lineStart: number, ctx: core.CompleterContext) {
	const uris = new Set<string>()
	for (const match of text.matchAll(/^[ \t]*import[ \t]+(\S+)/gm)) {
		if (match.index !== lineStart) {
			for (const uri of resolveImport(match[1], ctx.doc.uri, ctx.roots)) {
				uris.add(uri)
			}
		}
	}
	return uris
}

function folderItem(label: string, range: core.Range, detail = 'folder'): CompletionItem {
	return CompletionItem.create(label, range, {
		kind: CompletionKind.Folder,
		detail,
		sortText: `0${label}`,
		retrigger: true,
	})
}

function fileItem(name: string, range: core.Range): CompletionItem {
	return CompletionItem.create(name, range, {
		kind: CompletionKind.File,
		detail: name.endsWith('.mcbt') ? 'mc-build templates' : 'script import',
		sortText: `1${name}`,
	})
}
