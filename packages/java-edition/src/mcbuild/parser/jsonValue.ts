import * as core from '@spyglassmc/core'
import * as json from '@spyglassmc/json'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { JsNode, JsonDynamicNode } from '../node/index.js'
import { parseJs } from './js.js'

/** One IF/ELSE branch inside a JSON body, as document offsets. */
export interface JsonBranch {
	/** Shared by the branches of one IF/ELSE chain. */
	chain: number
	index: number
	start: number
	end: number
}

type Entry = json.JsonNode | JsonDynamicNode
/** A `core.PairNode` whose children may hold dynamic parts. */
interface Pair extends core.AstNode {
	type: 'pair'
	key?: json.JsonStringNode
	sep?: core.Range
	value?: json.JsonNode
	end?: core.Range
	children: Entry[]
}
/** A `core.ItemNode` whose child may be dynamic. */
interface Item extends core.AstNode {
	type: 'item'
	value?: json.JsonNode
	sep?: core.Range
	children: Entry[]
}

const StringOptions: core.StringOptions = { ...json.parser.JsonStringOptions, quotes: ['"', "'"] }
const LITERAL_START = /[A-Za-z_]/
const LITERAL_CHAR = /[A-Za-z0-9_.+-]/
const NUMBER_START = /[-0-9]/
const BOUNDARY_CHARS = new Set([',', ':', '[', ']', '{', '}', '"', "'"])

/**
 * Parses mc-build's relaxed JSON (a port of its `JsonParser`): commas are optional, keys and
 * simple string values may be unquoted, strings may use single quotes, and `//` and `/* *\/`
 * comments are allowed. `<% %>` keys, values and entries become {@link JsonDynamicNode}s.
 *
 * @param text The value's source, with IF/ELSE/REPEAT and `#` lines blanked out.
 * @param base Document offset of `text[0]`.
 */
export function parseJsonValue(
	text: string,
	base: number,
	branches: readonly JsonBranch[],
	ctx: core.ParserContext,
): Entry | undefined {
	return new JsonValueParser(text, base, branches, ctx).parseRoot()
}

class JsonValueParser {
	private i = 0

	constructor(
		private readonly text: string,
		private readonly base: number,
		private readonly branches: readonly JsonBranch[],
		private readonly ctx: core.ParserContext,
	) {}

	parseRoot(): Entry | undefined {
		this.skipWhitespace()
		if (this.i >= this.text.length) {
			this.error(localize('mcbuild.parser.json.expected-value'), this.i, this.i)
			return undefined
		}
		const value = this.parseValue()
		this.skipWhitespace()
		if (this.i < this.text.length) {
			this.error(localize('mcbuild.parser.json.trailing'), this.i, this.text.length)
		}
		return value
	}

	// #region helpers

	private range(start: number, end = this.i): core.Range {
		return core.Range.create(this.base + start, this.base + end)
	}

	private error(message: string, start: number, end = start + 1): void {
		this.ctx.err.report(message, this.range(start, Math.min(end, this.text.length)))
	}

	private peek(offset = 0): string | undefined {
		return this.text[this.i + offset]
	}

	private skipWhitespace(): void {
		while (this.i < this.text.length) {
			if (/\s/.test(this.text[this.i])) {
				this.i++
			} else if (this.text.startsWith('//', this.i)) {
				const end = this.text.indexOf('\n', this.i)
				this.i = end === -1 ? this.text.length : end
			} else if (this.text.startsWith('/*', this.i)) {
				const end = this.text.indexOf('*/', this.i + 2)
				if (end === -1) {
					this.error(localize('mcbuild.parser.json.unterminated-comment'), this.i, this.i + 2)
					this.i = this.text.length
				} else {
					this.i = end + 2
				}
			} else {
				return
			}
		}
	}

	private isAtBoundary(): boolean {
		const char = this.peek()
		return char === undefined || /\s/.test(char) || BOUNDARY_CHARS.has(char)
			|| this.text.startsWith('//', this.i) || this.text.startsWith('/*', this.i)
	}

	/** A source positioned at the cursor that ends with the current line. */
	private lineSource(): core.Source {
		const lineEnd = this.text.indexOf('\n', this.i)
		const src = new core.Source(
			lineEnd === -1 ? this.text : this.text.slice(0, lineEnd),
			[{ inner: core.Range.create(0), outer: core.Range.create(this.base) }],
		)
		src.innerCursor = this.i
		return src
	}

	// #endregion
	// #region values

	private parseValue(): Entry | undefined {
		const char = this.peek()
		if (char === '{') {
			return this.parseObject()
		}
		if (char === '[') {
			return this.parseArray()
		}
		if (char === '"' || char === "'") {
			return this.parseString()
		}
		if (this.text.startsWith('<%', this.i)) {
			return this.parseWord('value')
		}
		if (char !== undefined && NUMBER_START.test(char)) {
			return this.parseNumber()
		}
		if (char !== undefined && LITERAL_START.test(char)) {
			return this.parseWord('value')
		}
		if (char === '#') {
			const start = this.i
			this.error(localize('mcbuild.parser.json.quote-tag'), start, this.skipToBoundary())
			return this.unquotedString(start)
		}
		this.error(localize('mcbuild.parser.json.expected-value'), this.i)
		return undefined
	}

	private parseObject(): json.JsonObjectNode {
		const start = this.i++
		const node: core.Mutable<json.JsonObjectNode> = {
			type: 'json:object',
			range: this.range(start),
			children: [],
			relaxed: true,
		}
		const pairs = node.children as unknown as Pair[]
		while (true) {
			this.skipWhitespace()
			const char = this.peek()
			if (char === '}') {
				this.i++
				break
			}
			if (char === undefined || char === ']') {
				this.error(localize('mcbuild.parser.json.unclosed', localeQuote('}')), start)
				break
			}
			if (char === ',') {
				this.error(localize('mcbuild.parser.json.unexpected-comma'), this.i)
				this.i++
				continue
			}
			const pair = this.parsePair()
			if (!pair) {
				this.i++
				continue
			}
			pairs.push(pair)
		}
		node.range = this.range(start)
		node.innerRange = core.Range.create(
			node.range.start + 1,
			Math.max(node.range.start + 1, node.range.end - 1),
		)
		this.reportDuplicateKeys(pairs)
		return node
	}

	private parsePair(): Pair | undefined {
		const keyStart = this.i
		const char = this.peek()
		let key: Entry | undefined
		if (char === '"' || char === "'") {
			key = this.parseString()
		} else if (
			this.text.startsWith('<%', this.i) || (char !== undefined && LITERAL_START.test(char))
		) {
			key = this.parseWord('key')
		} else {
			this.error(localize('mcbuild.parser.json.expected-key'), this.i)
			return undefined
		}
		const pair: Pair = { type: 'pair', range: this.range(keyStart), children: [key] }
		if (key.type === 'json:string') {
			pair.key = key
		}
		const keyEnd = this.i
		this.skipWhitespace()
		if (this.peek() !== ':') {
			if (key.type === 'mcbuild:json_dynamic') {
				// A lone `<% %>` can make whole entries.
				this.i = keyEnd
				this.consumeSeparator(pair, '}')
			} else {
				this.error(localize('mcbuild.parser.json.expected-colon'), this.i)
			}
			return pair
		}
		pair.sep = this.range(this.i, this.i + 1)
		this.i++
		this.skipWhitespace()
		const value = this.parseValue()
		if (value) {
			pair.children.push(value)
			if (value.type !== 'mcbuild:json_dynamic') {
				pair.value = value
			}
		}
		pair.range = this.range(keyStart)
		this.consumeSeparator(pair, '}')
		return pair
	}

	private parseArray(): json.JsonArrayNode {
		const start = this.i++
		const node: core.Mutable<json.JsonArrayNode> = {
			type: 'json:array',
			range: this.range(start),
			children: [],
			relaxed: true,
		}
		const items = node.children as unknown as Item[]
		while (true) {
			this.skipWhitespace()
			const char = this.peek()
			if (char === ']') {
				this.i++
				break
			}
			if (char === undefined || char === '}') {
				this.error(localize('mcbuild.parser.json.unclosed', localeQuote(']')), start)
				break
			}
			if (char === ',') {
				this.error(localize('mcbuild.parser.json.unexpected-comma'), this.i)
				this.i++
				continue
			}
			const itemStart = this.i
			const value = this.parseValue()
			if (!value) {
				this.i++
				continue
			}
			const item: Item = { type: 'item', range: this.range(itemStart), children: [value] }
			if (value.type !== 'mcbuild:json_dynamic') {
				item.value = value
			}
			items.push(item)
			this.consumeSeparator(item, ']')
		}
		node.range = this.range(start)
		return node
	}

	/** An optional comma after an entry, which must end at a boundary. */
	private consumeSeparator(entry: Pair | Item, close: string): void {
		if (!this.isAtBoundary()) {
			this.error(localize('mcbuild.parser.json.expected-separator', localeQuote(close)), this.i)
			return
		}
		this.skipWhitespace()
		if (this.peek() === ',') {
			if (entry.type === 'pair') {
				entry.end = this.range(this.i, this.i + 1)
			} else {
				entry.sep = this.range(this.i, this.i + 1)
			}
			this.i++
		}
	}

	private parseString(): json.JsonStringNode | JsonDynamicNode {
		const start = this.i
		const src = this.lineSource()
		const node = core.setType('json:string', core.string(StringOptions))(src, this.ctx)
		this.i = src.innerCursor
		const raw = this.text.slice(start, this.i)
		return raw.includes('<%') ? this.dynamic(start, this.i) : node
	}

	private parseNumber(): Entry | undefined {
		const start = this.i
		const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
		match.lastIndex = this.i
		const found = match.exec(this.text)
		if (this.text.startsWith('<%', start + (found?.[0].length ?? 0))) {
			return this.parseWord('value')
		}
		if (!found) {
			this.error(localize('mcbuild.parser.json.invalid-number'), start)
			return undefined
		}
		const src = this.lineSource()
		src.string = src.string.slice(0, start + found[0].length)
		const node = json.parser.number(src, this.ctx) as json.JsonNumberNode
		this.i = start + found[0].length
		if (!this.isAtBoundary()) {
			this.error(localize('mcbuild.parser.json.invalid-number'), start, this.skipToBoundary())
		}
		return node
	}

	/** An unquoted key or value. `<% %>` may make up any part of it. */
	private parseWord(position: 'key' | 'value'): Entry {
		const start = this.i
		let dynamic = false
		while (this.i < this.text.length) {
			if (this.text.startsWith('<%', this.i)) {
				const end = this.text.indexOf('%>', this.i + 2)
				this.i = end === -1 ? this.text.length : end + 2
				dynamic = true
			} else if (LITERAL_CHAR.test(this.text[this.i])) {
				this.i++
			} else {
				break
			}
		}
		if (dynamic) {
			return this.dynamic(start, this.i)
		}
		const word = this.text.slice(start, this.i)
		const next = this.peek()
		if (
			position === 'value'
			&& (next === ':' || next === '#' || (next === '/' && !this.isAtBoundary()))
		) {
			this.error(
				localize('mcbuild.parser.json.unquoted-char', localeQuote(next)),
				start,
				this.skipToBoundary(),
			)
			return this.unquotedString(start)
		}
		const range = this.range(start)
		if (position === 'value' && (word === 'true' || word === 'false')) {
			return { type: 'json:boolean', range, value: word === 'true' }
		}
		if (position === 'value' && word === 'null') {
			return { type: 'json:null', range }
		}
		return this.unquotedString(start)
	}

	private unquotedString(start: number): json.JsonStringNode {
		const range = this.range(start)
		return {
			type: 'json:string',
			range,
			options: StringOptions,
			value: this.text.slice(start, this.i),
			valueMap: [{ inner: core.Range.create(0), outer: core.Range.create(range.start) }],
		}
	}

	/** Skips a malformed word, `:` and all, so one mistake makes one error. Returns its end. */
	private skipToBoundary(): number {
		while (this.i < this.text.length && (this.peek() === ':' || !this.isAtBoundary())) {
			this.i++
		}
		return this.i
	}

	private dynamic(start: number, end: number): JsonDynamicNode {
		const children: JsNode[] = []
		const raw = this.text.slice(start, end)
		for (const m of raw.matchAll(/<%([^]*?)(?:%>|$)/g)) {
			children.push(parseJs(m[1], this.base + start + m.index + 2, 'inline', this.ctx))
		}
		return { type: 'mcbuild:json_dynamic', range: this.range(start, end), children }
	}

	// #endregion

	/** Warns like mc-build, except between keys in different branches of one IF/ELSE chain. */
	private reportDuplicateKeys(pairs: readonly Pair[]): void {
		const seen: Pair[] = []
		for (const pair of pairs) {
			if (!pair.key) {
				continue
			}
			const key = pair.key.value
			if (seen.some((other) => other.key!.value === key && !this.exclusive(other, pair))) {
				this.ctx.err.report(
					localize('mcbuild.parser.json.duplicate-key', localeQuote(key)),
					pair.key.range,
					core.ErrorSeverity.Warning,
				)
			}
			seen.push(pair)
		}
	}

	private exclusive(a: Pair, b: Pair): boolean {
		const pathOf = (pair: Pair) =>
			this.branches.filter((br) => br.start <= pair.range.start && pair.range.start < br.end)
		const bPath = pathOf(b)
		return pathOf(a).some((x) => bPath.some((y) => x.chain === y.chain && x.index !== y.index))
	}
}
