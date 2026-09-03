import * as core from '@spyglassmc/core'
import * as mcf from '@spyglassmc/mcfunction'
import type { ArgumentParserGetter } from '@spyglassmc/mcfunction'
import type { CommandStatementNode, IdentifierNode, JsNode } from '../node/index.js'
import type { McbToken } from '../tokenizer.js'
import { parseJs } from './js.js'

const INLINE_JS = /<%([^]*?)%>/

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
	isMacro: boolean,
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
		node.interpolation = splitInterpolation(value, token, ctx)
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
		})
	}
	return node
}

/** Splits `value` into literal / `<% %>` JS parts. */
export function splitInterpolation(
	value: string,
	token: McbToken,
	ctx: core.ParserContext,
): (IdentifierNode | JsNode)[] {
	const parts: (IdentifierNode | JsNode)[] = []
	const base = token.range.start
	let last = 0
	for (const match of value.matchAll(/<%([^]*?)%>/g)) {
		const index = match.index
		if (index > last) {
			parts.push(literalPart(value.slice(last, index), base + last))
		}
		parts.push(parseJs(match[1], base + index + 2, 'inline', ctx))
		last = index + match[0].length
	}
	if (last < value.length) {
		parts.push(literalPart(value.slice(last), base + last))
	}
	return parts
}

function literalPart(text: string, start: number): IdentifierNode {
	return {
		type: 'mcbuild:identifier',
		range: core.Range.create(start, start + text.length),
		value: text,
	}
}
