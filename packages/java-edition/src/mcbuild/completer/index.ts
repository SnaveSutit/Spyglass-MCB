import * as core from '@spyglassmc/core'
import { CompletionItem, CompletionKind } from '@spyglassmc/core'
import { CommandNode } from '@spyglassmc/mcfunction'
import { fileBase, FUNCTION_CATEGORY, TEMPLATE_CATEGORY } from '../binder/index.js'
import { DirectoryDefinitionNode } from '../node/index.js'

export interface McbCompleterDeps {
	/** `mcf.completer.command`; mcfunction has no per-node command completer to dispatch to. */
	command: core.Completer<CommandNode>
}

const MCB_TLD_KEYWORDS = [
	'function',
	'dir',
	'clock',
	'import',
	'tag',
	'advancement',
	'enchantment',
	'item_modifier',
	'loot_table',
	'predicate',
	'recipe',
	'chat_type',
	'damage_type',
	'dimension',
	'dimension_type',
	'worldgen',
	'IF',
	'REPEAT',
]
const MCBT_TLD_KEYWORDS = ['template', 'import']
const TEMPLATE_BODY_KEYWORDS = ['with', 'load', 'tick']
const STATEMENT_KEYWORDS = [
	'function',
	'schedule',
	'execute',
	'block',
	'return run',
	'eq',
	'tick',
	'load',
	'IF',
	'REPEAT',
]
/** Singular (1.21+) `tag` registries. */
const TAG_REGISTRIES = [
	'function',
	'block',
	'item',
	'entity_type',
	'fluid',
	'game_event',
	'worldgen/biome',
]
const SCHEDULE_MODES = ['append', 'replace']
const TIME_HINTS = ['1t', '1s', '1d']
const REFERENCE_PREFIXES: { label: string; detail: string }[] = [
	{ label: './', detail: 'relative to this file' },
	{ label: '../', detail: 'relative to the parent directory' },
	{ label: '^0', detail: 'the enclosing block' },
	{ label: '*', detail: 'project-absolute path' },
	{ label: '#', detail: 'function tag' },
]

type ContainerKind = 'mcb-tld' | 'mcbt-tld' | 'template-body' | 'statement' | 'unknown'

/** Nodes from `root` down to the deepest one containing `offset`. */
function pathTo(root: core.AstNode, offset: number): core.AstNode[] {
	const path: core.AstNode[] = []
	let current: core.AstNode | undefined = root
	while (current && core.Range.contains(current.range, offset, true)) {
		path.push(current)
		current = current.children?.find((c) => core.Range.contains(c.range, offset, true))
	}
	return path
}

/** Whether `offset` is in `node`'s body rather than its header. */
function inBody(node: core.AstNode, offset: number): boolean {
	const body = (node as { body?: core.AstNode }).body
	return !!body && core.Range.contains(body.range, offset, true)
}

function containerKind(
	path: core.AstNode[],
	offset: number,
	variant: 'mcb' | 'mcbt',
): ContainerKind {
	for (let i = path.length - 1; i >= 0; i--) {
		const node = path[i]
		switch (node.type) {
			case 'mcbuild:function_definition':
			case 'mcbuild:clock_definition':
			case 'mcbuild:schedule_block':
				return inBody(node, offset) ? 'statement' : 'unknown'
			case 'mcbuild:template_overload':
			case 'mcbuild:block':
			case 'mcbuild:tick_block':
			case 'mcbuild:load_block':
			case 'mcbuild:execute_block':
			case 'mcbuild:return_run':
			case 'mcbuild:compiletime_if':
			case 'mcbuild:compiletime_loop':
			case 'mcbuild:body':
				return 'statement'
			case 'mcbuild:template_definition':
				return 'template-body'
			case 'mcbuild:directory_definition':
				return inBody(node, offset) ? 'mcb-tld' : 'unknown'
			case 'mcbuild:entry':
				return variant === 'mcbt' ? 'mcbt-tld' : 'mcb-tld'
		}
	}
	return 'unknown'
}

function keywordItems(words: readonly string[], range: core.RangeLike): CompletionItem[] {
	return words.map((w) => CompletionItem.create(w, range, { kind: CompletionKind.Keyword }))
}

function declaredNames(ctx: core.CompleterContext, category: string): string[] {
	const symbols = ctx.symbols.getVisibleSymbols(category, ctx.doc.uri)
	return Object.entries(symbols).flatMap(([name, symbol]) =>
		core.SymbolUtil.isDeclared(symbol) ? [name] : []
	)
}

function templateItems(ctx: core.CompleterContext, range: core.RangeLike): CompletionItem[] {
	return declaredNames(ctx, TEMPLATE_CATEGORY).map((name) =>
		CompletionItem.create(name, range, {
			kind: CompletionKind.Function,
			detail: 'mc-build template',
		})
	)
}

/** Runs the completer of the deepest non-mc-build node at the cursor. */
function delegate(path: core.AstNode[], ctx: core.CompleterContext): CompletionItem[] {
	for (let i = path.length - 1; i >= 0; i--) {
		const node = path[i]
		if (
			!node.type.startsWith('mcbuild:') && ctx.meta.hasCompleter(node.type)
		) {
			return ctx.meta.getCompleter(node.type)(node, ctx)
		}
	}
	return []
}

type RefScheme = 'none' | 'relative' | 'absolute' | 'parent' | 'id'

function refScheme(typed: string): RefScheme {
	if (typed.startsWith('./') || typed.startsWith('../') || typed === '.' || typed === '..') {
		return 'relative'
	}
	if (typed.startsWith('*')) {
		return 'absolute'
	}
	if (typed.startsWith('^')) {
		return 'parent'
	}
	if (typed.includes(':')) {
		return 'id'
	}
	return 'none'
}

/** Shortest `./` / `../` path from `anchor` to `target`, if `target` isn't `anchor`. */
function relativeSpelling(
	anchor: readonly string[],
	target: readonly string[],
): string | undefined {
	let common = 0
	while (
		common < anchor.length && common < target.length && anchor[common] === target[common]
	) {
		common++
	}
	const ups = anchor.length - common
	const downs = target.slice(common)
	if (downs.length === 0) {
		return undefined
	}
	return ups === 0 ? `./${downs.join('/')}` : `${'../'.repeat(ups)}${downs.join('/')}`
}

/** Function reference targets, spelled to match the sigil typed so far. */
function referenceItems(
	ctx: core.CompleterContext,
	range: core.RangeLike,
	typedSoFar: string,
	dirStack: readonly string[],
): CompletionItem[] {
	const items: CompletionItem[] = []
	const isTag = typedSoFar.startsWith('#')
	const rest = isTag ? typedSoFar.slice(1) : typedSoFar
	const scheme = refScheme(rest)
	const tag = isTag ? '#' : ''

	if (!isTag && scheme === 'none') {
		for (const p of REFERENCE_PREFIXES) {
			items.push(CompletionItem.create(p.label, range, {
				kind: CompletionKind.Operator,
				detail: p.detail,
			}))
		}
	}
	if (scheme === 'parent') {
		for (const depth of ['^0', '^1', '^2']) {
			items.push(CompletionItem.create(`${tag}${depth}`, range, {
				kind: CompletionKind.Operator,
				detail: 'enclosing block',
			}))
		}
		return items
	}

	const base = fileBase(ctx.doc.uri)
	const anchor = base ? [...base.path, ...dirStack] : undefined
	const seen = new Set<string>()
	const add = (label: string, detail: string) => {
		// After a sigil, only offer spellings that extend what was typed.
		if (scheme !== 'none' && !label.startsWith(typedSoFar)) {
			return
		}
		if (seen.has(label)) {
			return
		}
		seen.add(label)
		items.push(CompletionItem.create(label, range, { kind: CompletionKind.Function, detail }))
	}

	const ids = [
		...declaredNames(ctx, 'function').map((n) => [n, 'function'] as const),
		...declaredNames(ctx, FUNCTION_CATEGORY).map((n) => [n, 'mc-build function'] as const),
	]
	for (const [id, detail] of ids) {
		const colon = id.indexOf(':')
		if ((scheme === 'none' || scheme === 'id') && colon >= 0) {
			add(`${tag}${id}`, detail)
		}
		if (colon < 0 || !base || !anchor) {
			continue
		}
		const ns = id.slice(0, colon)
		const path = id.slice(colon + 1).split('/')
		if (ns !== base.namespace) {
			continue
		}
		if (scheme === 'absolute') {
			add(`${tag}*${path.join('/')}`, detail)
		} else if (scheme === 'relative' || scheme === 'none') {
			const rel = relativeSpelling(anchor, path)
			if (rel) {
				add(`${tag}${rel}`, detail)
			}
		}
	}
	return items
}

/**
 * The last command starting on the cursor's line before it. Containment alone
 * misses a cursor after a trailing space (`execute |`).
 */
function embeddedCommandAt(
	root: core.AstNode,
	ctx: core.CompleterContext,
): CommandNode | undefined {
	const lineStart = ctx.doc.getText().lastIndexOf('\n', ctx.offset - 1) + 1
	let best: CommandNode | undefined
	const visit = (n: core.AstNode) => {
		if (
			CommandNode.is(n)
			&& n.range.start >= lineStart && n.range.start <= ctx.offset
			&& (!best || n.range.start >= best.range.start)
		) {
			best = n
		}
		for (const c of n.children ?? []) {
			visit(c)
		}
	}
	visit(root)
	return best
}

function commandItems(
	root: core.AstNode,
	ctx: core.CompleterContext,
	deps: McbCompleterDeps,
): CompletionItem[] {
	const node = embeddedCommandAt(root, ctx) ?? CommandNode.mock(ctx.offset)
	return deps.command(node, ctx)
}

export function entry(deps: McbCompleterDeps): core.Completer<core.AstNode> {
	return (node, ctx) => complete(node as core.AstNode, ctx, deps)
}

const complete = (
	node: core.AstNode,
	ctx: core.CompleterContext,
	deps: McbCompleterDeps,
): CompletionItem[] => {
	const text = ctx.doc.getText()
	const variant: 'mcb' | 'mcbt' = ctx.doc.uri.endsWith('.mcbt') ? 'mcbt' : 'mcb'

	const lineStart = text.lastIndexOf('\n', ctx.offset - 1) + 1
	const linePrefix = text.slice(lineStart, ctx.offset)
	const trimmed = linePrefix.replace(/^\s+/, '')
	const word = /[\w./^*#$:-]*$/.exec(linePrefix)?.[0] ?? ''
	const wordRange = core.Range.create(ctx.offset - word.length, ctx.offset)

	const path = pathTo(node, ctx.offset)
	const dirStack = path
		.filter(DirectoryDefinitionNode.is)
		.map((n) => n.id.value)
	const container = containerKind(path, ctx.offset, variant)

	// Past the first word, a line that isn't an mc-build statement is a command or JSON.
	const hasSpace = /\S\s/.test(trimmed)
	const looksLikeCommand = hasSpace
		&& !/^(function|schedule|import|tag)\b/.test(trimmed)
	if (looksLikeCommand || trimmed.startsWith('/')) {
		const delegated = delegate(path, ctx)
		if (delegated.length > 0) {
			return delegated
		}
		if (container === 'statement') {
			return commandItems(node, ctx, deps)
		}
	}

	const importMatch = /^import\s+(\S*)$/.exec(trimmed)
	if (importMatch) {
		return [
			CompletionItem.create('./', wordRange, {
				kind: CompletionKind.Folder,
				detail: 'relative import',
			}),
			CompletionItem.create('/', wordRange, {
				kind: CompletionKind.Folder,
				detail: 'project-root import',
			}),
		]
	}

	const fnRefMatch = /^function\s+\S+\s+(\S*)$/.exec(trimmed)
		|| /^function\s+(\S*)$/.exec(trimmed)
	if (fnRefMatch && container === 'statement') {
		return referenceItems(ctx, wordRange, fnRefMatch[1] ?? '', dirStack)
	}

	const schedMatch = /^schedule\s+(.*)$/.exec(trimmed)
	if (schedMatch) {
		const rest = schedMatch[1]
		if (/^\S*$/.test(rest)) {
			return [
				CompletionItem.create('function', wordRange, { kind: CompletionKind.Keyword }),
				CompletionItem.create('clear', wordRange, { kind: CompletionKind.Keyword }),
				...TIME_HINTS.map((t) =>
					CompletionItem.create(t, wordRange, { kind: CompletionKind.Unit })
				),
			]
		}
		const schedFnRef = /^function\s+(\S*)$/.exec(rest)
		if (schedFnRef) {
			return referenceItems(ctx, wordRange, schedFnRef[1], dirStack)
		}
		if (/^function\s+\S+\s+\S*$/.test(rest)) {
			return TIME_HINTS.map((t) =>
				CompletionItem.create(t, wordRange, { kind: CompletionKind.Unit })
			)
		}
		if (/\d[tsd]?\s+\S*$/.test(rest)) {
			return keywordItems(SCHEDULE_MODES, wordRange)
		}
		const clearRef = /^clear\s+(\S*)$/.exec(rest)
		if (clearRef) {
			return referenceItems(ctx, wordRange, clearRef[1], dirStack)
		}
	}

	if (/^tag\s+\S*$/.test(trimmed) && variant === 'mcb') {
		return TAG_REGISTRIES.map((r) =>
			CompletionItem.create(r, wordRange, { kind: CompletionKind.EnumMember })
		)
	}

	const refNode = [...path].reverse().find((n) => n.type === 'mcbuild:reference')
	if (refNode) {
		return referenceItems(ctx, refNode.range, word, dirStack)
	}

	if (!hasSpace) {
		switch (container) {
			case 'statement':
				return [
					...keywordItems(STATEMENT_KEYWORDS, wordRange),
					...templateItems(ctx, wordRange),
					...commandItems(node, ctx, deps),
				]
			case 'template-body':
				return keywordItems(TEMPLATE_BODY_KEYWORDS, wordRange)
			case 'mcbt-tld':
				return keywordItems(MCBT_TLD_KEYWORDS, wordRange)
			case 'mcb-tld':
				return keywordItems(MCB_TLD_KEYWORDS, wordRange)
		}
	}

	if (container === 'statement') {
		return commandItems(node, ctx, deps)
	}
	return delegate(path, ctx)
}
