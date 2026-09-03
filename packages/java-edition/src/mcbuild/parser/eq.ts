import * as core from '@spyglassmc/core'
import { localize } from '@spyglassmc/locales'
import type {
	EqExpressionNode,
	EqOperandNode,
	EqSelectorOperandNode,
	EqStatementNode,
	IdentifierNode,
} from '../node/index.js'

/** `eq <holder> <obj> <op> <expr>` parser, ported from mc-build's `McMath.ts`. */

const SEPARATORS = new Set(['=', '+=', '-=', '*=', '/=', '%='])
const BIN_OPS = new Set(['+', '-', '*', '/', '%'])

interface EqToken {
	kind: 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'separator'
	value: string
	range: core.Range
}

function isIdentStart(ch: string): boolean {
	return /[A-Za-z_$@#]/.test(ch)
}
function isIdentPart(ch: string): boolean {
	return /[A-Za-z0-9_$@#.]/.test(ch)
}

function lex(text: string, base: number, ctx: core.ParserContext): EqToken[] {
	const tokens: EqToken[] = []
	let i = 0
	while (i < text.length) {
		const ch = text[i]
		if (ch === ' ' || ch === '\t') {
			i++
			continue
		}
		const start = base + i
		if (ch === '(' || ch === ')') {
			tokens.push({
				kind: ch === '(' ? 'lparen' : 'rparen',
				value: ch,
				range: core.Range.create(start, start + 1),
			})
			i++
			continue
		}
		// Before bare operators, so `+=` isn't read as `+`.
		if (BIN_OPS.has(ch) && text[i + 1] === '=') {
			tokens.push({
				kind: 'separator',
				value: ch + '=',
				range: core.Range.create(start, start + 2),
			})
			i += 2
			continue
		}
		if (ch === '=') {
			tokens.push({ kind: 'separator', value: '=', range: core.Range.create(start, start + 1) })
			i++
			continue
		}
		if (BIN_OPS.has(ch)) {
			tokens.push({ kind: 'operator', value: ch, range: core.Range.create(start, start + 1) })
			i++
			continue
		}
		if (ch >= '0' && ch <= '9') {
			let j = i + 1
			while (j < text.length && text[j] >= '0' && text[j] <= '9') {
				j++
			}
			if (text[j] === '.') {
				ctx.err.report(
					localize('mcbuild.parser.eq.no-decimals'),
					core.Range.create(start, base + j + 1),
				)
				j++
				while (j < text.length && text[j] >= '0' && text[j] <= '9') {
					j++
				}
			}
			tokens.push({
				kind: 'number',
				value: text.slice(i, j),
				range: core.Range.create(start, base + j),
			})
			i = j
			continue
		}
		if (isIdentStart(ch)) {
			let j = i + 1
			while (j < text.length && isIdentPart(text[j])) {
				j++
			}
			tokens.push({
				kind: 'identifier',
				value: text.slice(i, j),
				range: core.Range.create(start, base + j),
			})
			i = j
			continue
		}
		ctx.err.report(
			localize('mcbuild.parser.eq.unexpected-char', ch),
			core.Range.create(start, start + 1),
		)
		i++
	}
	return tokens
}

function ident(token: EqToken): IdentifierNode {
	return { type: 'mcbuild:identifier', range: token.range, value: token.value }
}

function operator(token: EqToken): core.AstNode {
	return { type: 'mcbuild:eq_operator', range: token.range }
}

class EqParser {
	private pos = 0
	constructor(
		private readonly tokens: EqToken[],
		private readonly fallbackRange: core.Range,
		private readonly ctx: core.ParserContext,
	) {}

	private peek(): EqToken | undefined {
		return this.tokens[this.pos]
	}
	private next(): EqToken | undefined {
		return this.tokens[this.pos++]
	}
	private rangeAt(): core.Range {
		return this.peek()?.range ?? this.tokens[this.tokens.length - 1]?.range ?? this.fallbackRange
	}
	private report(message: string): void {
		this.ctx.err.report(message, this.rangeAt())
	}
	private errorExpr(): EqExpressionNode {
		return { type: 'error', range: this.rangeAt() }
	}

	parseStatement(): EqStatementNode | undefined {
		const holder = this.next()
		const objective = this.next()
		const separator = this.next()
		if (!holder || !objective || !separator) {
			this.ctx.err.report(
				localize('mcbuild.parser.eq.incomplete'),
				this.tokens[0]?.range ?? this.fallbackRange,
			)
			return undefined
		}
		if (separator.kind !== 'separator' || !SEPARATORS.has(separator.value)) {
			this.ctx.err.report(
				localize('mcbuild.parser.eq.expected-operator', separator.value),
				separator.range,
			)
		}
		const target: EqOperandNode = {
			type: 'mcbuild:eq_operand',
			range: core.Range.span(holder.range, objective.range),
			holder: ident(holder),
			objective: ident(objective),
			children: [ident(holder), ident(objective)],
		}
		const expression = this.parseAddSub()
		if (this.peek()) {
			this.report(localize('mcbuild.parser.eq.trailing', this.peek()!.value))
		}
		const opNode = operator(separator)
		return {
			type: 'mcbuild:eq_statement',
			range: core.Range.span(target.range, expression.range),
			target,
			operator: opNode,
			expression,
			children: [target, opNode, expression],
		}
	}

	private parseAddSub(): EqExpressionNode {
		let node = this.parseMulDiv()
		while (this.peek()?.kind === 'operator' && ['+', '-'].includes(this.peek()!.value)) {
			const op = operator(this.next()!)
			const right = this.parseMulDiv()
			node = {
				type: 'mcbuild:eq_binary',
				range: core.Range.span(node.range, right.range),
				operator: op,
				left: node,
				right,
				children: [node, op, right],
			}
		}
		return node
	}

	private parseMulDiv(): EqExpressionNode {
		let node = this.parsePrimary()
		while (this.peek()?.kind === 'operator' && ['*', '/', '%'].includes(this.peek()!.value)) {
			const op = operator(this.next()!)
			const right = this.parsePrimary()
			node = {
				type: 'mcbuild:eq_binary',
				range: core.Range.span(node.range, right.range),
				operator: op,
				left: node,
				right,
				children: [node, op, right],
			}
		}
		return node
	}

	private parsePrimary(): EqExpressionNode {
		const token = this.peek()
		if (!token) {
			this.report(localize('mcbuild.parser.eq.incomplete'))
			return this.errorExpr()
		}
		if (token.kind === 'number') {
			this.next()
			return {
				type: 'mcbuild:eq_literal',
				range: token.range,
				value: Number.parseInt(token.value, 10),
			}
		}
		if (token.kind === 'operator' && (token.value === '-' || token.value === '+')) {
			const op = operator(this.next()!)
			const operand = this.parsePrimary()
			if (token.value === '+') {
				return operand
			}
			return {
				type: 'mcbuild:eq_unary',
				range: core.Range.span(op.range, operand.range),
				operator: op,
				operand,
				children: [op, operand],
			}
		}
		if (token.kind === 'lparen') {
			this.next()
			const inner = this.parseAddSub()
			const closing = this.peek()
			if (closing?.kind === 'rparen') {
				this.next()
			} else {
				this.report(localize('mcbuild.parser.eq.unmatched-paren'))
			}
			return inner
		}
		if (token.kind === 'identifier') {
			const holder = this.next()!
			const objective = this.peek()
			if (objective?.kind === 'identifier') {
				this.next()
				if (holder.value.startsWith('@')) {
					const selector: core.AstNode = { type: 'mcbuild:eq_selector', range: holder.range }
					const objNode = ident(objective)
					const sel: EqSelectorOperandNode = {
						type: 'mcbuild:eq_selector_operand',
						range: core.Range.span(holder.range, objective.range),
						selector,
						objective: objNode,
						children: [selector, objNode],
					}
					return sel
				}
				const operand: EqOperandNode = {
					type: 'mcbuild:eq_operand',
					range: core.Range.span(holder.range, objective.range),
					holder: ident(holder),
					objective: ident(objective),
					children: [ident(holder), ident(objective)],
				}
				return operand
			}
			this.ctx.err.report(
				localize('mcbuild.parser.eq.missing-objective'),
				holder.range,
			)
			return { type: 'error', range: holder.range }
		}
		this.report(localize('mcbuild.parser.eq.unexpected-token', token.value))
		this.next()
		return this.errorExpr()
	}
}

export function parseEq(
	text: string,
	baseOffset: number,
	fallbackRange: core.Range,
	ctx: core.ParserContext,
): EqStatementNode | undefined {
	const tokens = lex(text, baseOffset, ctx)
	if (tokens.length === 0) {
		ctx.err.report(localize('mcbuild.parser.eq.incomplete'), fallbackRange)
		return undefined
	}
	return new EqParser(tokens, fallbackRange, ctx).parseStatement()
}
