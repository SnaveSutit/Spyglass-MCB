import * as core from '@spyglassmc/core'
import { localize } from '@spyglassmc/locales'
import * as acorn from 'acorn'
import type { JsNode } from '../node/index.js'

const ACORN_OPTIONS: acorn.Options = {
	ecmaVersion: 'latest',
	sourceType: 'module',
	allowReturnOutsideFunction: true,
	allowAwaitOutsideFunction: true,
	allowSuperOutsideMethod: true,
	locations: false,
}

/**
 * Reports JS syntax errors only. Scripts get globals from imported libraries,
 * so scope checks would be all false positives.
 *
 * @param baseOffset Document offset of `source[0]`.
 * @param context `'multiline'` for `<%% %%>` (statements); otherwise an expression.
 */
export function parseJs(
	source: string,
	baseOffset: number,
	context: JsNode['context'],
	ctx: core.ParserContext,
): JsNode {
	const wantsExpression = context !== 'multiline'
	const node: JsNode = {
		type: 'mcbuild:js',
		range: core.Range.create(baseOffset, baseOffset + source.length),
		context,
		source,
		loose: false,
	}

	if (source.trim().length === 0) {
		if (wantsExpression) {
			ctx.err.report(localize('mcbuild.parser.js.empty-expression'), node.range)
		}
		return node
	}

	// Parens make `{a:1}` parse as an object and reject statements.
	const wrapped = wantsExpression ? `(\n${source}\n)` : source
	const wrapOffset = wantsExpression ? -2 : 0 // "(" + "\n" prefix

	try {
		acorn.parse(wrapped, ACORN_OPTIONS)
	} catch (e) {
		node.loose = true
		const acornErr = e as unknown as { pos?: number }
		if (e instanceof SyntaxError && typeof acornErr.pos === 'number') {
			// The parens can put `pos` outside the span.
			const pos = Math.min(
				Math.max(acornErr.pos + wrapOffset + baseOffset, node.range.start),
				node.range.end,
			)
			ctx.err.report(
				cleanAcornMessage((e as Error).message),
				core.Range.create(pos, Math.min(pos + 1, node.range.end)),
			)
		} else {
			ctx.err.report(localize('mcbuild.parser.js.parse-failed'), node.range)
		}
	}

	return node
}

function cleanAcornMessage(message: string): string {
	// Drop acorn's "(line:col)" suffix.
	return message.replace(/\s*\(\d+:\d+\)\s*$/, '')
}
