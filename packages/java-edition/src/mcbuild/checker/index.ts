import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import { CommandNode } from '@spyglassmc/mcfunction'
import * as mcfChecker from '../../mcfunction/checker/index.js'
import type { TemplateParamData } from '../binder/index.js'
import { describeParams, getTemplateData, TEMPLATE_CATEGORY } from '../binder/index.js'
import type { DocComment } from '../doc.js'
import { getDocComment } from '../doc.js'
import type {
	CommandStatementNode,
	FunctionCallNode,
	FunctionDefinitionNode,
	ReferenceNode,
} from '../node/index.js'
import { EntryNode, IdentifierNode } from '../node/index.js'
import { addTemplate } from '../quickFix.js'

/** Checks a command line as a template call if its first word is a template, else as a command. */
const command: core.Checker<CommandStatementNode> = async (node, ctx) => {
	const word = firstWord(node, ctx)
	let isTemplate = false
	if (word) {
		for (const uri of importUris(node, ctx)) {
			await ctx.ensureBindingStarted?.(uri)
		}
		const query = ctx.symbols.query(ctx.doc, TEMPLATE_CATEGORY, word.name)
		query.ifKnown((symbol) => {
			isTemplate = true
			query.enter({ usage: { type: 'reference', range: word.range } })
			node.symbol = symbol
			reportDeprecated(getTemplateData(symbol)?.doc, word.name, word.range, ctx)
			checkTemplateArgs(node, symbol, word, ctx)
		})
	}

	if (!isTemplate && word?.explicit) {
		const templateFile = importUris(node, ctx).find((uri) => uri.endsWith('.mcbt'))
		ctx.err.report(
			localize('mcbuild.checker.template.unknown', localeQuote(word.name)),
			word.range,
			core.ErrorSeverity.Warning,
			templateFile ? { codeAction: addTemplate(word.name, templateFile) } : undefined,
		)
		isTemplate = true
	}

	// This checker stops the dispatcher descending, so check children by hand.
	if (!isTemplate) {
		for (const e of node.deferredErrors ?? []) {
			ctx.err.report(e.message, e.range, e.severity, e.info)
		}
		if (CommandNode.is(node.command)) {
			mcfChecker.command(node.command, ctx)
		}
	}
	for (const child of node.children) {
		if (child.type === 'mcbuild:block') {
			await core.checker.fallback(child, ctx)
		}
	}
}

interface FirstWord {
	name: string
	range: core.Range
	/** Written as `template <name>`, mc-build's explicit call form. */
	explicit: boolean
}

function firstWord(node: CommandStatementNode, ctx: core.CheckerContext): FirstWord | undefined {
	const text = ctx.doc.getText().slice(node.range.start, node.range.end)
	const match = /^\s*\$?\s*(template\s+)?([A-Za-z_][\w./-]*)/.exec(text)
	if (!match) {
		return undefined
	}
	const start = node.range.start + match[0].length - match[2].length
	return {
		name: match[2],
		range: core.Range.create(start, start + match[2].length),
		explicit: match[1] !== undefined,
	}
}

/** Resolves the enclosing file's `import` statements to absolute URIs. */
function importUris(node: core.AstNode, ctx: core.CheckerContext): string[] {
	let entry: core.AstNode | undefined = node
	while (entry && !EntryNode.is(entry)) {
		entry = entry.parent
	}
	if (!entry) {
		return []
	}
	const uris: string[] = []
	for (const child of entry.children ?? []) {
		if (child.type !== 'mcbuild:import') {
			continue
		}
		const spec = (child as { path?: { value: string } }).path?.value
		if (!spec) {
			continue
		}
		try {
			if (spec.startsWith('/')) {
				for (const root of ctx.roots) {
					uris.push(new URL('.' + spec, root.endsWith('/') ? root : root + '/').href)
				}
			} else {
				const rel = spec.startsWith('./') || spec.startsWith('../') ? spec : './' + spec
				uris.push(new URL(rel, ctx.doc.uri).href)
			}
		} catch {
		}
	}
	return uris
}

interface CallArg {
	kind: 'js' | 'word'
	text: string
}

/**
 * Warns when no `with` overload matches, following mc-build's `McTemplate.process`.
 * A `<% %>` argument matches any param but `block`, since its value is unknown.
 */
function checkTemplateArgs(
	node: CommandStatementNode,
	symbol: core.Symbol,
	word: FirstWord,
	ctx: core.CheckerContext,
): void {
	const data = getTemplateData(symbol)
	if (!data || data.overloads.length === 0) {
		return
	}

	const argsEnd = node.trailing ? node.trailing.range.start : node.range.end
	const text = ctx.doc.getText().slice(word.range.end, argsEnd)
	const args: CallArg[] = [...text.matchAll(/<%[^]*?%>|\S+/g)].map((m) => ({
		kind: m[0].startsWith('<%') ? 'js' : 'word',
		text: m[0],
	}))
	const hasBlock = !!node.trailing

	for (const overload of data.overloads) {
		if (matchOverload(overload.params, args, hasBlock)) {
			return
		}
	}

	ctx.err.report(
		localize(
			'mcbuild.checker.template.no-overload',
			word.name,
			data.overloads.map((o) => describeParams(o.params) || '(no arguments)').join(' | '),
		),
		node.range,
		core.ErrorSeverity.Warning,
	)
}

function matchOverload(
	params: readonly TemplateParamData[],
	args: readonly CallArg[],
	hasBlock: boolean,
): boolean {
	let ai = 0
	let blockUsed = false
	for (const param of params) {
		if (param.kind === 'block') {
			if (!hasBlock || blockUsed) {
				return false
			}
			blockUsed = true
			continue
		}
		if (param.kind === 'raw') {
			if (ai >= args.length) {
				return false
			}
			ai = args.length
			continue
		}
		const arg = args[ai]
		if (!arg) {
			return false
		}
		if (param.kind === 'js') {
			if (arg.kind !== 'js') {
				return false
			}
		} else if (arg.kind !== 'js') {
			if (param.kind === 'int' && Number.isNaN(Number.parseInt(arg.text, 10))) {
				return false
			}
			if (param.kind === 'float' && Number.isNaN(Number.parseFloat(arg.text))) {
				return false
			}
			if (param.kind === 'literal' && arg.text !== param.name) {
				return false
			}
		}
		ai++
	}
	return ai === args.length && (!hasBlock || blockUsed)
}

/** Warns on `$(x)` in a documented function's body when `x` has no `@arg`. */
const functionDefinition: core.Checker<FunctionDefinitionNode> = async (node, ctx) => {
	const doc = getDocComment(node.id.symbol)
	if (doc && doc.args.length > 0 && node.body) {
		const declared = new Set(doc.args.map((a) => a.name))
		const text = ctx.doc.getText().slice(node.body.range.start, node.body.range.end)
		for (const match of text.matchAll(/\$\((\w+)\)/g)) {
			if (!declared.has(match[1])) {
				const start = node.body.range.start + match.index + 2
				ctx.err.report(
					localize('mcbuild.checker.macro.undeclared', localeQuote(match[1])),
					core.Range.create(start, start + match[1].length),
					core.ErrorSeverity.Warning,
				)
			}
		}
	}
	// This checker stops the dispatcher descending, so check children by hand.
	if (node.body) {
		await core.checker.fallback(node.body, ctx)
	}
}

/** Checks literal `{…}` macro data against the target's `@arg`s. */
const functionCall: core.Checker<FunctionCallNode> = async (node, ctx) => {
	const doc = getDocComment(node.target.symbol)
	if (doc && doc.args.length > 0 && node.target.resolved) {
		const id = localeQuote(node.target.resolved)
		const keys = IdentifierNode.is(node.data) ? compoundKeys(node.data.value) : undefined
		if (!node.data) {
			ctx.err.report(
				localize(
					'mcbuild.checker.macro.no-data',
					id,
					doc.args.map((a) => localeQuote(a.name)).join(', '),
				),
				node.target.range,
				core.ErrorSeverity.Warning,
			)
		} else if (keys && IdentifierNode.is(node.data)) {
			const start = node.data.range.start
			for (const key of keys) {
				if (!doc.args.some((a) => a.name === key.name)) {
					ctx.err.report(
						localize('mcbuild.checker.macro.unknown', localeQuote(key.name), id),
						core.Range.create(start + key.offset, start + key.offset + key.length),
						core.ErrorSeverity.Warning,
					)
				}
			}
			for (const arg of doc.args) {
				if (!keys.some((k) => k.name === arg.name)) {
					ctx.err.report(
						localize('mcbuild.checker.macro.missing', localeQuote(arg.name), id),
						node.data.range,
						core.ErrorSeverity.Warning,
					)
				}
			}
		}
	}
	await core.checker.fallback(node.target, ctx)
}

/** Warns on references to `@deprecated` functions and function tags. */
const reference: core.SyncChecker<ReferenceNode> = (node, ctx) => {
	if (node.resolved) {
		reportDeprecated(getDocComment(node.symbol), node.resolved, node.range, ctx)
	}
}

function reportDeprecated(
	doc: DocComment | undefined,
	name: string,
	range: core.Range,
	ctx: core.CheckerContext,
) {
	if (doc?.deprecated === undefined) {
		return
	}
	const message = localize('mcbuild.checker.deprecated', localeQuote(name))
	ctx.err.report(
		doc.deprecated ? `${message}: ${doc.deprecated}` : message,
		range,
		core.ErrorSeverity.Warning,
		{ deprecated: true },
	)
}

interface CompoundKey {
	name: string
	/** Offset of the key in the compound text. */
	offset: number
	length: number
}

/**
 * Top-level keys of a literal SNBT compound, or `undefined` when it isn't one or has build-time
 * parts (`<% %>`, `$(…)`) whose keys can't be known.
 */
export function compoundKeys(text: string): CompoundKey[] | undefined {
	const trimmed = text.trimEnd()
	if (!trimmed.startsWith('{') || !trimmed.endsWith('}') || /<%|\$\(/.test(trimmed)) {
		return undefined
	}
	const keys: CompoundKey[] = []
	let depth = 0
	let expectKey = false
	for (let i = 0; i < trimmed.length; i++) {
		const c = trimmed[i]
		if (c === '"' || c === "'") {
			const end = closingQuote(trimmed, i)
			if (depth === 1 && expectKey) {
				keys.push({ name: trimmed.slice(i + 1, end), offset: i, length: end + 1 - i })
				expectKey = false
			}
			i = end
		} else if (c === '{' || c === '[') {
			depth++
			expectKey = c === '{' && depth === 1
		} else if (c === '}' || c === ']') {
			depth--
		} else if (c === ',' && depth === 1) {
			expectKey = true
		} else if (depth === 1 && expectKey && /[\w.+-]/.test(c)) {
			const match = /^[\w.+-]+/.exec(trimmed.slice(i))!
			keys.push({ name: match[0], offset: i, length: match[0].length })
			expectKey = false
			i += match[0].length - 1
		}
	}
	return depth === 0 ? keys : undefined
}

function closingQuote(text: string, start: number): number {
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === '\\') {
			i++
		} else if (text[i] === text[start]) {
			return i
		}
	}
	return text.length - 1
}

export function register(meta: core.MetaRegistry): void {
	meta.registerChecker<CommandStatementNode>('mcbuild:command', command)
	meta.registerChecker<FunctionDefinitionNode>('mcbuild:function_definition', functionDefinition)
	meta.registerChecker<FunctionCallNode>('mcbuild:function_call', functionCall)
	meta.registerChecker<ReferenceNode>('mcbuild:reference', reference)
}
