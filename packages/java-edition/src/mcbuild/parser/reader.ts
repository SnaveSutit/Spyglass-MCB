import * as core from '@spyglassmc/core'
import type { McbToken } from '../tokenizer.js'

/** Token cursor, mirroring mc-build's `ArrayInput` (including in-place `insert` / `update`). */
export class TokenReader {
	private index = 0

	constructor(private readonly tokens: McbToken[]) {}

	hasNext(): boolean {
		return this.index < this.tokens.length
	}

	peek(): McbToken | undefined {
		return this.tokens[this.index]
	}

	lookahead(offset: number): McbToken | undefined {
		return this.tokens[this.index + offset]
	}

	next(): McbToken | undefined {
		return this.tokens[this.index++]
	}

	skip(): void {
		this.index++
	}

	back(): void {
		this.index--
	}

	last(): McbToken | undefined {
		return this.tokens[this.index - 1]
	}

	insert(token: McbToken): void {
		this.tokens.splice(this.index, 0, token)
	}

	update(token: McbToken): void {
		this.tokens[this.index] = token
	}

	/** End of the last consumed token. */
	get endOffset(): number {
		return this.last()?.range.end ?? 0
	}
}

/** A literal token whose offsets map to source from `range.start`. */
export function syntheticLiteral(value: string, range: core.Range): McbToken {
	return {
		type: 'literal',
		value,
		range,
		indexMap: [{ inner: core.Range.create(0), outer: core.Range.create(range.start) }],
	}
}

/** A literal token of `prefix + rest`, where only `rest` maps to source at `range.start`. */
export function syntheticPrefixed(
	prefix: string,
	rest: string,
	range: core.Range,
): McbToken {
	return {
		type: 'literal',
		value: prefix + rest,
		range,
		indexMap: [{
			inner: core.Range.create(0, prefix.length),
			outer: core.Range.create(range.start),
		}],
	}
}

/** A sub-token for `token.value.slice(from, to)` that keeps the `\`-continuation index map. */
export function sliceToken(token: McbToken, from: number, to: number): McbToken {
	const value = token.value.slice(from, to)
	const start = core.IndexMap.toOuterOffset(token.indexMap, from)
	const end = core.IndexMap.toOuterOffset(token.indexMap, to)
	const indexMap: core.IndexMap = [{
		inner: core.Range.create(0),
		outer: core.Range.create(start),
	}]
	for (const pair of token.indexMap) {
		// Keep the join pairs inside the slice, rebased.
		if (pair.inner.start > from && pair.inner.start < to) {
			indexMap.push({
				inner: core.Range.create(pair.inner.start - from, pair.inner.end - from),
				outer: pair.outer,
			})
		}
	}
	return { type: 'literal', value, range: core.Range.create(start, end), indexMap }
}

/** Reports `message` and returns an error node. */
export function errorNode(
	message: string,
	range: core.Range,
	ctx: core.ParserContext,
): core.ErrorNode {
	ctx.err.report(message, range)
	return { type: 'error', range }
}
