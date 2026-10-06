import * as core from '@spyglassmc/core'
import * as mcf from '@spyglassmc/mcfunction'
import type { ArgumentParserGetter } from '@spyglassmc/mcfunction'
import type { CommandStatementNode, IdentifierNode, JsNode } from '../node/index.js'
import type { McbToken } from '../tokenizer.js'
import { parseJs } from './js.js'

const INLINE_JS = /<%([^]*?)%>/
const INLINE_JS_GLOBAL = /<%([^]*?)%>/g

/** A `core.Source` over a token's text that reports document ranges. */
export function tokenSource(token: McbToken): core.Source {
	const value = token.type === 'literal'
		? token.value
		: token.type === 'bracket_open'
		? token.data ?? ''
		: ''
	return new core.Source(value, token.indexMap)
}

export interface CommandBridgeOptions {
	tree: mcf.RootTreeNode
	argument: ArgumentParserGetter
	commandOptions: mcf.CommandOptions
}

/**
 * Parses a function-body command line. Lines with `<% %>` are only split into
 * literal / JS parts, since their shape is unknown until the JS runs; lines with
 * `$(...)` parse as macros.
 */
export function parseCommandStatement(
	token: McbToken,
	options: CommandBridgeOptions,
	ctx: core.ParserContext,
	/** Store command errors in {@link CommandStatementNode.deferredErrors} instead of reporting. */
	deferCommandErrors = false,
): CommandStatementNode {
	const value = token.type === 'literal' ? token.value : ''
	const node: CommandStatementNode = {
		type: 'mcbuild:command',
		range: token.range,
		children: [],
	}

	if (INLINE_JS.test(value)) {
		node.interpolation = splitInterpolation(token, ctx)
		node.children = node.interpolation
		return node
	}

	const src = tokenSource(token)
	const hasMacroArgs = value.includes('$(')
	const commandCtx = deferCommandErrors && !hasMacroArgs
		? { ...ctx, err: new core.ErrorReporter(ctx.err.source) }
		: ctx
	const command = hasMacroArgs
		? mcf.macro(false)(src, ctx)
		: mcf.command(options.tree, options.argument, options.commandOptions)(src, commandCtx)
	node.command = command
	node.children = [command]
	if (commandCtx !== ctx && commandCtx.err.errors.length > 0) {
		Object.defineProperty(node, 'deferredErrors', {
			value: [...commandCtx.err.errors],
			enumerable: false,
			configurable: true,
		})
	}
	return node
}

/** Splits `token.value` into literal / `<% %>` JS parts. */
export function splitInterpolation(
	token: McbToken,
	ctx: core.ParserContext,
): (IdentifierNode | JsNode)[] {
	const value = token.value
	const at = (offset: number) => core.IndexMap.toOuterOffset(token.indexMap, offset)
	const literalPart = (from: number, to: number): IdentifierNode => ({
		type: 'mcbuild:identifier',
		range: core.Range.create(at(from), at(to)),
		value: value.slice(from, to),
	})
	const parts: (IdentifierNode | JsNode)[] = []
	let last = 0
	for (const match of value.matchAll(INLINE_JS_GLOBAL)) {
		const index = match.index
		if (index > last) {
			parts.push(literalPart(last, index))
		}
		parts.push(parseJs(match[1], at(index + 2), 'inline', ctx))
		last = index + match[0].length
	}
	if (last < value.length) {
		parts.push(literalPart(last, value.length))
	}
	return parts
}
