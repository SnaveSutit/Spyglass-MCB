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

/**
 * The acorn AST of a script that parsed cleanly, with node offsets relative to `node.source`;
 * `undefined` if it didn't.
 */
export function jsAst(node: Pick<JsNode, 'context' | 'loose' | 'source'>): acorn.Node | undefined {
	if (node.loose || node.source.trim().length === 0) {
		return undefined
	}
	try {
		if (node.context === 'multiline') {
			return acorn.parse(node.source, ACORN_OPTIONS)
		}
		// Same parens as `parseJs`, offset back by their "(\n".
		return shiftOffsets(acorn.parse(`(\n${node.source}\n)`, ACORN_OPTIONS), -2)
	} catch {
		return undefined
	}
}

function shiftOffsets<T extends acorn.Node>(root: T, delta: number): T {
	for (const n of walkJs(root)) {
		n.start += delta
		n.end += delta
	}
	return root
}

/** Every node in an acorn AST, parents first. */
export function* walkJs(node: acorn.Node): Generator<acorn.Node> {
	yield node
	for (const value of Object.values(node)) {
		for (const child of Array.isArray(value) ? value : [value]) {
			if (isJsNode(child)) {
				yield* walkJs(child)
			}
		}
	}
}

function isJsNode(value: unknown): value is acorn.Node {
	const node = value as Partial<acorn.Node> | undefined
	return typeof node?.type === 'string' && typeof node.start === 'number'
}

function cleanAcornMessage(message: string): string {
	// Drop acorn's "(line:col)" suffix.
	return message.replace(/\s*\(\d+:\d+\)\s*$/, '')
}
