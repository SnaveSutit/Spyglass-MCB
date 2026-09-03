import * as core from '@spyglassmc/core'
import { localize } from '@spyglassmc/locales'
import * as mcfChecker from '../../mcfunction/checker/index.js'
import type { TemplateParamData } from '../binder/index.js'
import { getTemplateData, TEMPLATE_CATEGORY } from '../binder/index.js'
import type { CommandStatementNode, EqStatementNode, ReferenceNode } from '../node/index.js'
import { EntryNode } from '../node/index.js'

const reference: core.SyncChecker<ReferenceNode> = () => {
	// Target resolution is future work.
}

const eqStatement: core.SyncChecker<EqStatementNode> = () => {
	// The eq parser reports diagnostics; objective resolution is future work.
}

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
			checkTemplateArgs(node, symbol, word, ctx)
		})
	}

	// This checker stops the dispatcher descending, so check children by hand.
	if (!isTemplate) {
		for (const e of node.deferredErrors ?? []) {
			ctx.err.report(e.message, e.range, e.severity, e.info)
		}
		const cmd = node.children.find((c) => c.type === 'mcfunction:command')
		if (cmd) {
			mcfChecker.command(cmd as never, ctx)
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
}

function firstWord(node: CommandStatementNode, ctx: core.CheckerContext): FirstWord | undefined {
	const text = ctx.doc.getText().slice(node.range.start, node.range.end)
	const match = /^\s*\$?\s*([A-Za-z_][\w./-]*)/.exec(text)
	if (!match) {
		return undefined
	}
	const start = node.range.start + match[0].length - match[1].length
	return { name: match[1], range: core.Range.create(start, start + match[1].length) }
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
			data.overloads.map((o) => describeOverload(o.params)).join(' | '),
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

function describeOverload(params: readonly TemplateParamData[]): string {
	if (params.length === 0) {
		return '(no arguments)'
	}
	return params
		.map((p) => (p.kind === 'literal' ? p.name : `${p.name}:${p.kind}`))
		.join(' ')
}

export function register(meta: core.MetaRegistry): void {
	meta.registerChecker<ReferenceNode>('mcbuild:reference', reference)
	meta.registerChecker<EqStatementNode>('mcbuild:eq_statement', eqStatement)
	meta.registerChecker<CommandStatementNode>('mcbuild:command', command)
}
