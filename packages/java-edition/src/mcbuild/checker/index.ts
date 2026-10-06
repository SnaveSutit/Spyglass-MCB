import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import { CommandNode } from '@spyglassmc/mcfunction'
import type * as acorn from 'acorn'
import * as mcfChecker from '../../mcfunction/checker/index.js'
import type { TemplateOverloadData, TemplateParamData } from '../binder/index.js'
import { describeParams, getTemplateData, TEMPLATE_CATEGORY } from '../binder/index.js'
import type { DocComment } from '../doc.js'
import { getDocComment, paramType } from '../doc.js'
import { importAction, importedUris, isTemplateInScope } from '../imports.js'
import type {
	CommandStatementNode,
	FunctionCallNode,
	FunctionDefinitionNode,
	JsNode,
	ReferenceNode,
	TemplateDefinitionNode,
} from '../node/index.js'
import { IdentifierNode } from '../node/index.js'
import { checkParamType, paramTypeParser } from '../paramTypes.js'
import { jsAst, walkJs } from '../parser/js.js'
import { addTemplate } from '../quickFix.js'

/** Checks a command line as a template call if its first word is a template, else as a command. */
const command: core.Checker<CommandStatementNode> = async (node, ctx) => {
	const word = firstWord(node, ctx)
	let isTemplate = false
	if (word) {
		for (const uri of importedUris(node, ctx)) {
			await ctx.ensureBindingStarted?.(uri)
		}
		const query = ctx.symbols.query(ctx.doc, TEMPLATE_CATEGORY, word.name)
		query.ifKnown((symbol) => {
			isTemplate = true
			if (!isTemplateInScope(symbol.definition, node, ctx)) {
				const file = symbol.definition?.find((l) => l.uri.endsWith('.mcbt'))?.uri
				ctx.err.report(
					localize('mcbuild.checker.template.not-imported', localeQuote(word.name)),
					word.range,
					core.ErrorSeverity.Error,
					file ? { codeAction: importAction(ctx.doc, file) } : undefined,
				)
				return
			}
			query.enter({ usage: { type: 'reference', range: word.range } })
			node.symbol = symbol
			reportDeprecated(getTemplateData(symbol)?.doc, word.name, word.range, ctx)
			checkTemplateArgs(node, symbol, word, ctx)
		})
	}

	if (!isTemplate && word?.explicit) {
		const templateFile = importedUris(node, ctx).find((uri) => uri.endsWith('.mcbt'))
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

interface CallArg {
	kind: 'js' | 'word'
	text: string
	/** Document offsets. */
	range: core.Range
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
	const args: CallArg[] = [...text.matchAll(/<%[^]*?%>|\S+/g)].map((m) => {
		const start = word.range.end + m.index
		return {
			kind: m[0].startsWith('<%') ? 'js' : 'word',
			text: m[0],
			range: core.Range.create(start, start + m[0].length),
		}
	})
	const hasBlock = !!node.trailing

	for (const overload of data.overloads) {
		const matched = matchOverload(overload.params, args, hasBlock, ctx)
		if (matched) {
			checkParamTypes(overload, data.doc, matched, ctx)
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

/**
 * The argument each param takes (`raw` takes the rest as one; `block` takes none), or `undefined`
 * if the call doesn't fit the overload.
 */
function matchOverload(
	params: readonly TemplateParamData[],
	args: readonly CallArg[],
	hasBlock: boolean,
	ctx: core.CheckerContext,
): (CallArg | undefined)[] | undefined {
	const taken: (CallArg | undefined)[] = []
	let ai = 0
	let blockUsed = false
	for (const param of params) {
		if (param.kind === 'block') {
			if (!hasBlock || blockUsed) {
				return undefined
			}
			blockUsed = true
			taken.push(undefined)
			continue
		}
		if (param.kind === 'raw') {
			if (ai >= args.length) {
				return undefined
			}
			const range = core.Range.create(args[ai].range.start, args[args.length - 1].range.end)
			const text = ctx.doc.getText().slice(range.start, range.end)
			taken.push({ kind: /<%/.test(text) ? 'js' : 'word', text, range })
			ai = args.length
			continue
		}
		const arg = args[ai]
		if (!arg) {
			return undefined
		}
		if (param.kind === 'js') {
			if (arg.kind !== 'js') {
				return undefined
			}
		} else if (arg.kind !== 'js') {
			if (param.kind === 'int' && Number.isNaN(Number.parseInt(arg.text, 10))) {
				return undefined
			}
			if (param.kind === 'float' && Number.isNaN(Number.parseFloat(arg.text))) {
				return undefined
			}
			if (param.kind === 'literal' && arg.text !== param.name) {
				return undefined
			}
		}
		taken.push(arg)
		ai++
	}
	return ai === args.length && (!hasBlock || blockUsed) ? taken : undefined
}

/** Checks arguments against `@param name {Type}` from the overload's or the template's doc. */
function checkParamTypes(
	overload: TemplateOverloadData,
	templateDoc: DocComment | undefined,
	taken: readonly (CallArg | undefined)[],
	ctx: core.CheckerContext,
) {
	for (const [i, param] of overload.params.entries()) {
		const arg = taken[i]
		const type = paramType(param.name, overload.doc, templateDoc)
		const parser = type && paramTypeParser(type)
		if (!arg || arg.kind === 'js' || !parser) {
			continue
		}
		const problem = checkParamType(arg.text, parser, ctx)
		if (problem) {
			ctx.err.report(
				localize('mcbuild.checker.type-mismatch', localeQuote(param.name), type, problem),
				arg.range,
				core.ErrorSeverity.Warning,
			)
		}
	}
}

/** The comment lines directly above `node`. */
function commentsAbove(node: core.AstNode): core.CommentNode[] {
	const siblings = node.parent?.children ?? []
	const above: core.CommentNode[] = []
	// By range: checker nodes are proxies, so identity doesn't hold.
	const index = siblings.findIndex((s) => s.range.start === node.range.start)
	for (let i = index - 1; i >= 0; i--) {
		const sibling = siblings[i]
		if (!core.CommentNode.is(sibling)) {
			break
		}
		above.push(sibling)
	}
	return above
}

/** Warns on `@arg` / `@param` types that aren't Minecraft argument types. */
function reportUnknownTypes(nodes: readonly core.AstNode[], ctx: core.CheckerContext) {
	for (const comment of nodes.filter(core.CommentNode.is)) {
		const text = ctx.doc.getText().slice(comment.range.start, comment.range.end)
		const match = /@(?:arg|param)\s+\S+\s*\{([^}]*)\}/.exec(text)
		if (match && !paramTypeParser(match[1].trim())) {
			const start = comment.range.start + match.index + match[0].length - 1 - match[1].length
			ctx.err.report(
				localize('mcbuild.checker.unknown-type', localeQuote(match[1].trim())),
				core.Range.create(start, start + match[1].length),
				core.ErrorSeverity.Warning,
			)
		}
	}
}

/** Warns on unknown `@param` types above the template or a `with`. */
const templateDefinition: core.Checker<TemplateDefinitionNode> = async (node, ctx) => {
	reportUnknownTypes([...commentsAbove(node), ...node.children], ctx)
	// This checker stops the dispatcher descending, so check children by hand.
	for (const child of node.children) {
		await core.checker.fallback(child, ctx)
	}
}

/** Warns on unknown `@arg` types, and on `$(x)` in the body when `x` has no `@arg`. */
const functionDefinition: core.Checker<FunctionDefinitionNode> = async (node, ctx) => {
	reportUnknownTypes(commentsAbove(node), ctx)
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
				const key = keys.find((k) => k.name === arg.name)
				if (!key) {
					ctx.err.report(
						localize('mcbuild.checker.macro.missing', localeQuote(arg.name), id),
						node.data.range,
						core.ErrorSeverity.Warning,
					)
				}
				const parser = arg.type ? paramTypeParser(arg.type) : undefined
				const problem = key?.value && parser
					&& checkParamType(macroValue(key.value.text), parser, ctx)
				if (key?.value && arg.type && problem) {
					const valueStart = start + key.value.offset
					ctx.err.report(
						localize(
							'mcbuild.checker.type-mismatch',
							localeQuote(arg.name),
							arg.type,
							problem,
						),
						core.Range.create(valueStart, valueStart + key.value.text.length),
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
	/** The value's trimmed text and its offset in the compound text. */
	value?: { text: string; offset: number }
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
	let valueStart: number | undefined
	const endValue = (end: number) => {
		const key = keys[keys.length - 1]
		if (key && valueStart !== undefined) {
			const raw = trimmed.slice(valueStart, end)
			key.value = { text: raw.trim(), offset: valueStart + raw.length - raw.trimStart().length }
		}
		valueStart = undefined
	}
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
			if (depth === 0) {
				endValue(i)
			}
		} else if (c === ':' && depth === 1 && valueStart === undefined && !expectKey) {
			valueStart = i + 1
		} else if (c === ',' && depth === 1) {
			endValue(i)
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

/** The text mc-build substitutes for `$(x)`: a string's contents, else the SNBT as written. */
function macroValue(snbt: string): string {
	return /^(["']).*\1$/s.test(snbt) ? snbt.slice(1, -1).replace(/\\(.)/g, '$1') : snbt
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

/** Flags `REPEAT(…)` calls whose literal arguments match none of its overloads. */
const js: core.SyncChecker<JsNode> = (node, ctx) => {
	const ast = jsAst(node)
	if (!ast) {
		return
	}
	for (const n of walkJs(ast)) {
		const call = n as acorn.CallExpression
		if (n.type !== 'CallExpression' || call.callee.type !== 'Identifier') {
			continue
		}
		const types = call.arguments.map(literalType)
		if (call.callee.name !== 'REPEAT' || types.includes(undefined) || repeatAccepts(types)) {
			continue
		}
		ctx.err.report(
			localize('mcbuild.checker.repeat.args', types.join(', ')),
			core.Range.create(node.range.start + call.start, node.range.start + call.end),
			core.ErrorSeverity.Warning,
		)
	}
}

/** mc-build's `REPEAT` overloads: 1–3 numbers, or one array, object or function. */
function repeatAccepts(types: readonly (string | undefined)[]): boolean {
	return (types.length >= 1 && types.length <= 3 && types.every((t) => t === 'number'))
		|| (types.length === 1 && types[0] === 'object')
		|| (types.length === 1 && types[0] === 'function')
}

/** The `typeof` of a literal argument; `undefined` when it's only known at build time. */
function literalType(arg: acorn.Expression | acorn.SpreadElement): string | undefined {
	switch (arg.type) {
		case 'Literal':
			return typeof arg.value
		case 'UnaryExpression':
			return arg.operator === '-' || arg.operator === '+' ? literalType(arg.argument) : undefined
		case 'TemplateLiteral':
			return arg.expressions.length === 0 ? 'string' : undefined
		case 'ArrayExpression':
		case 'ObjectExpression':
			return 'object'
		case 'ArrowFunctionExpression':
		case 'FunctionExpression':
			return 'function'
		default:
			return undefined
	}
}

export function register(meta: core.MetaRegistry): void {
	meta.registerChecker<CommandStatementNode>('mcbuild:command', command)
	meta.registerChecker<FunctionDefinitionNode>('mcbuild:function_definition', functionDefinition)
	meta.registerChecker<FunctionCallNode>('mcbuild:function_call', functionCall)
	meta.registerChecker<ReferenceNode>('mcbuild:reference', reference)
	meta.registerChecker<JsNode>('mcbuild:js', js)
	meta.registerChecker<TemplateDefinitionNode>('mcbuild:template_definition', templateDefinition)
}
