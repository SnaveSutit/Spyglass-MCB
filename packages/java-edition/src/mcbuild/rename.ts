import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import {
	FUNCTION_CATEGORY,
	FUNCTION_TAG_CATEGORY,
	TEMPLATE_CATEGORY,
	VANILLA_FUNCTION_CATEGORY,
} from './binder/index.js'
import { EntryNode } from './node/index.js'

const ResourceCategories = new Set([
	VANILLA_FUNCTION_CATEGORY,
	FUNCTION_TAG_CATEGORY,
	FUNCTION_CATEGORY,
])

/** Renames functions, clocks, function tags and templates in `.mcb` / `.mcbt` files. */
export const renameProvider: core.RenameProvider<core.FileNode<core.AstNode>> = (file, ctx) => {
	if (!EntryNode.is(file.children[0] as core.AstNode | undefined)) {
		return undefined
	}
	const found = symbolAt(file, ctx)
	if (!found) {
		return undefined
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
	if (!(isTemplate ? /^[A-Za-z_][\w-]*$/ : /^[a-z0-9_.-]+$/).test(newName)) {
		return localize(
			isTemplate ? 'mcbuild.rename.invalid-template' : 'mcbuild.rename.invalid-id',
			localeQuote(newName),
		)
	}
	const edits = new Map<string, core.DocumentRenameEdits>()
	for (const location of symbolLocations(symbol)) {
		if (ctx.isGenerated(location.uri)) {
			continue
		}
		if (!location.range || location.range.start === location.range.end) {
			// Defined by a file's path; renaming would mean moving that file.
			return localize(
				'mcbuild.rename.file-defined',
				localeQuote(symbol.identifier),
				location.uri,
			)
		}
		const doc = await ctx.getDocument(location.uri)
		if (!doc) {
			continue
		}
		const range = isTemplate ? location.range : lastSegment(doc.getText(), location.range)
		if (!range) {
			// `^N` names its target by position.
			continue
		}
		const entry = edits.get(doc.uri) ?? { doc, edits: [] }
		entry.edits.push({ range, text: newName })
		edits.set(doc.uri, entry)
	}
	return [...edits.values()]
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
