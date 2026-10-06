import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import {
	fileBase,
	FUNCTION_CATEGORY,
	FUNCTION_TAG_CATEGORY,
	TEMPLATE_CATEGORY,
	VANILLA_FUNCTION_CATEGORY,
} from './binder/index.js'
import { DirectoryDefinitionNode, EntryNode } from './node/index.js'
import { isInScript, localTarget } from './renameLocal.js'

const ResourceCategories = new Set([
	VANILLA_FUNCTION_CATEGORY,
	FUNCTION_TAG_CATEGORY,
	FUNCTION_CATEGORY,
])

/**
 * Renames functions, clocks, function tags, templates, `dir`s and local names (see
 * {@link localTarget}) in `.mcb` / `.mcbt` files.
 */
export const renameProvider: core.RenameProvider<core.FileNode<core.AstNode>> = (file, ctx) => {
	if (!EntryNode.is(file.children[0] as core.AstNode | undefined)) {
		return undefined
	}
	const local = localTarget(file, ctx)
	if (local || isInScript(file, ctx.offset)) {
		// Script names are never the line's template or function.
		return local
	}
	const found = symbolAt(file, ctx)
	if (!found) {
		return dirTarget(file, ctx)
	}
	const { node, symbol } = found
	const text = ctx.doc.getText()
	const name = symbol.category === TEMPLATE_CATEGORY
		? templateNameAt(text, node.range)
		: lastSegment(text, node.range)
	if (!name) {
		return localize('mcbuild.rename.parent-ref')
	}
	return {
		range: name,
		placeholder: text.slice(name.start, name.end),
		rename: (newName) => renameSymbol(symbol, newName, ctx),
	}
}

/** The deepest node at the cursor carrying an mc-build-renameable symbol, with that symbol. */
function symbolAt(
	file: core.DeepReadonly<core.AstNode>,
	ctx: core.RenameProviderContext,
): { node: core.DeepReadonly<core.AstNode>; symbol: core.Symbol } | undefined {
	let node = core.AstNode.findDeepestChild({
		node: file as core.AstNode,
		needle: ctx.offset,
		endInclusive: true,
	})
	for (; node; node = node.parent) {
		const category = node.symbol?.category
		if (category && (ResourceCategories.has(category) || category === TEMPLATE_CATEGORY)) {
			const symbol = ctx.symbols.lookup(category, node.symbol!.path).symbol
			return symbol && { node, symbol }
		}
	}
	return undefined
}

async function renameSymbol(
	symbol: core.Symbol,
	newName: string,
	ctx: core.RenameProviderContext,
): Promise<core.DocumentRenameEdits[] | string> {
	const isTemplate = symbol.category === TEMPLATE_CATEGORY
	if (!(isTemplate ? /^[A-Za-z_][\w-]*$/ : IdSegment).test(newName)) {
		return localize(
			isTemplate ? 'mcbuild.rename.invalid-template' : 'mcbuild.rename.invalid-id',
			localeQuote(newName),
		)
	}
	const edits = new RenameEdits()
	const refusal = await edits.add(symbol, newName, ctx, (text, range) =>
		// `lastSegment` skips `^N`, which names its target by position.
		isTemplate ? range : lastSegment(text, range))
	return refusal ?? edits.toArray()
}

/** A valid function, tag or `dir` name segment. */
const IdSegment = /^[a-z0-9_.-]+$/

/** Rename edits grouped by document. */
class RenameEdits {
	readonly #byUri = new Map<string, core.DocumentRenameEdits>()

	/**
	 * Adds an edit for each usage of `symbol` where `pick` finds the text to replace. Generated
	 * copies are skipped. Returns a refusal if a file defines `symbol` by its path.
	 */
	async add(
		symbol: core.Symbol,
		text: string,
		ctx: core.RenameProviderContext,
		pick: (docText: string, range: core.Range) => core.Range | undefined,
	): Promise<string | undefined> {
		for (const location of symbolLocations(symbol)) {
			if (ctx.isGenerated(location.uri)) {
				continue
			}
			if (!location.range || location.range.start === location.range.end) {
				// Renaming would mean moving that file.
				return localize(
					'mcbuild.rename.file-defined',
					localeQuote(symbol.identifier),
					location.uri,
				)
			}
			const doc = await ctx.getDocument(location.uri)
			const range = doc && pick(doc.getText(), location.range)
			if (doc && range) {
				this.push(doc, { range, text })
			}
		}
		return undefined
	}

	push(doc: TextDocument, edit: core.RenameEdit) {
		const entry: core.DocumentRenameEdits = this.#byUri.get(doc.uri) ?? { doc, edits: [] }
		if (!entry.edits.some((e) => e.range.start === edit.range.start)) {
			entry.edits.push(edit)
		}
		this.#byUri.set(doc.uri, entry)
	}

	toArray(): core.DocumentRenameEdits[] {
		return [...this.#byUri.values()]
	}
}

/** Renames a `dir`: its name, and every reference that spells a path through it. */
function dirTarget(
	file: core.DeepReadonly<core.AstNode>,
	ctx: core.RenameProviderContext,
): core.RenameTarget | undefined {
	const id = core.AstNode.findDeepestChild({
		node: file as core.AstNode,
		needle: ctx.offset,
		endInclusive: true,
	})
	const dir = id?.parent
	if (!DirectoryDefinitionNode.is(dir) || dir.id.range.start !== id!.range.start) {
		return undefined
	}
	const outer: string[] = []
	for (let n = dir.parent; n; n = n.parent) {
		if (DirectoryDefinitionNode.is(n)) {
			outer.unshift(n.id.value)
		}
	}
	const base = fileBase(ctx.doc.uri)
	const path = [...(base?.path ?? []), ...outer, dir.id.value].join('/')
	const prefix = base ? `${base.namespace}:${path}/` : `${path}/`
	const old = dir.id.value
	return {
		range: dir.id.range,
		placeholder: old,
		rename: async (newName) => {
			if (!IdSegment.test(newName)) {
				return localize('mcbuild.rename.invalid-id', localeQuote(newName))
			}
			const edits = new RenameEdits()
			edits.push(ctx.doc, { range: dir.id.range, text: newName })
			for (const category of ResourceCategories) {
				for (const symbol of Object.values(ctx.symbols.global[category] ?? {})) {
					const inDir = symbol.identifier.startsWith(prefix)
						&& symbol.definition?.some((l) =>
							l.uri === ctx.doc.uri && l.range
							&& core.Range.containsRange(dir.range, l.range)
						)
					if (!inDir) {
						continue
					}
					const rest = symbol.identifier.slice(prefix.length)
					const refusal = await edits.add(symbol, newName, ctx, (text, range) => {
						// Only spellings through the dir change; relative ones from inside stay valid.
						const spelled = text.slice(range.start, range.end).replace(/["']$/, '')
						const through = new RegExp(
							`(^|[/:*#.])${escapeRegExp(old)}/${escapeRegExp(rest)}$`,
						)
							.exec(spelled)
						if (!through) {
							return undefined
						}
						const start = range.start + through.index + through[1].length
						return core.Range.create(start, start + old.length)
					})
					if (refusal) {
						return refusal
					}
				}
			}
			return edits.toArray()
		},
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every usage of `symbol`, without duplicates. */
export function symbolLocations(symbol: core.Symbol): core.SymbolLocation[] {
	const seen = new Set<string>()
	return core.SymbolUsageTypes.flatMap((type) => symbol[type] ?? []).filter((l) => {
		const key = `${l.uri}#${l.range?.start}-${l.range?.end}`
		return !seen.has(key) && seen.add(key)
	})
}

/**
 * The name's last segment within `range`: `foo` in `./bar/foo`, `ns:foo` or `"ns:foo"`.
 * `undefined` for `^N` references, which have no name.
 */
export function lastSegment(text: string, range: core.Range): core.Range | undefined {
	const spelled = text.slice(range.start, range.end).replace(/["']$/, '')
	if (/^#?\^\d+/.test(spelled)) {
		return undefined
	}
	const segment = /[^/:#*^"'\s]+$/.exec(spelled)
	return segment
		? core.Range.create(range.start + segment.index, range.start + spelled.length)
		: undefined
}

/** The template name at the start of a call line or definition name. */
function templateNameAt(text: string, range: core.Range): core.Range | undefined {
	const match = /^\s*\$?\s*(?:template\s+)?([A-Za-z_][\w./-]*)/.exec(
		text.slice(range.start, range.end),
	)
	if (!match) {
		return undefined
	}
	const start = range.start + match[0].length - match[1].length
	return core.Range.create(start, start + match[1].length)
}
