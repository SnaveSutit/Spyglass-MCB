import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import * as mcdoc from '@spyglassmc/mcdoc'
import type { JsNode, JsonFileKind, JsonValueNode } from '../node/index.js'
import { parseJs } from './js.js'
import type { JsonBranch } from './jsonValue.js'
import { parseJsonValue } from './jsonValue.js'

/** Plural `tag` registry names mc-build accepts, mapped to their singular form. */
const TAG_REGISTRY_ALIASES: Record<string, string> = {
	functions: 'function',
	blocks: 'block',
	items: 'item',
	entity_types: 'entity_type',
	fluids: 'fluid',
	game_events: 'game_event',
}

function createTagDefinition(registry: string): mcdoc.McdocType {
	const normalized = TAG_REGISTRY_ALIASES[registry] ?? registry
	const id: mcdoc.AttributeValue = {
		kind: 'tree',
		values: {
			registry: { kind: 'literal', value: { kind: 'string', value: normalized } },
			tags: { kind: 'literal', value: { kind: 'string', value: 'allowed' } },
		},
	}
	return {
		kind: 'concrete',
		child: mcdoc.typeRef('tag'),
		typeArgs: [{ kind: 'string', attributes: [{ name: 'id', value: id }] }],
	}
}

/** The mcdoc type for a data-file body, as `json/checker` resolves it for a real file. */
export function jsonFileType(
	kind: JsonFileKind,
	registry: string | undefined,
): mcdoc.McdocType | undefined {
	switch (kind) {
		case 'tag':
			return registry ? createTagDefinition(registry) : undefined
		case 'worldgen':
			return registry ? resourceType(`worldgen/${registry}`) : undefined
		case 'json':
			return registry && !registry.includes('<%') ? resourceType(registry) : undefined
		default:
			return resourceType(kind)
	}
}

function resourceType(folder: string): mcdoc.McdocType {
	return {
		kind: 'dispatcher',
		registry: 'minecraft:resource',
		parallelIndices: [{ kind: 'static', value: folder }],
	}
}

/**
 * Bracket depth across JSON lines, skipping strings, comments and `<% %>`.
 * A port of mc-build's `JsonDepthScanner`.
 */
class JsonDepthScanner {
	depth = 0
	inBlockComment = false

	scan(text: string): void {
		let i = 0
		while (i < text.length) {
			if (this.inBlockComment) {
				const end = text.indexOf('*/', i)
				if (end === -1) {
					return
				}
				this.inBlockComment = false
				i = end + 2
			} else if (text[i] === '"' || text[i] === "'") {
				i = skipString(text, i)
			} else if (text.startsWith('<%', i)) {
				const end = text.indexOf('%>', i + 2)
				if (end === -1) {
					return
				}
				i = end + 2
			} else if (text.startsWith('//', i)) {
				return
			} else if (text.startsWith('/*', i)) {
				this.inBlockComment = true
				i += 2
			} else {
				if (text[i] === '{' || text[i] === '[') {
					this.depth++
				} else if (text[i] === '}' || text[i] === ']') {
					this.depth--
				}
				i++
			}
		}
	}
}

function skipString(text: string, start: number): number {
	const quote = text[start]
	let i = start + 1
	while (i < text.length) {
		if (text[i] === '\\') {
			i += 2
		} else if (text[i] === quote) {
			return i + 1
		} else {
			i++
		}
	}
	return i
}

const CONTROL_LINE = /^(?:IF|REPEAT)[\s(]/
const ELSE_LINE = /^ELSE(?:[\s{]|$)/

interface Line {
	start: number
	end: number
	text: string
}

/** The rest of the line that closes an IF/ELSE/REPEAT block, after its `}`. */
interface Closing {
	text: string
	start: number
	line: Line
}

/**
 * Reads a data file's JSON value starting at `start`, the way mc-build does: a `{` or `[`
 * value ends with the line that balances it, anything else with its own line. IF/ELSE/REPEAT
 * lines and `#` comment lines are blanked out, so every branch's entries parse together.
 */
export function readJsonValue(
	fullText: string,
	start: number,
	type: mcdoc.McdocType | undefined,
	ctx: core.ParserContext,
): { node: JsonValueNode; end: number } {
	const lines = new JsonLines(fullText, start, ctx)
	const end = lines.read()
	const text = lines.blankedText(start, end)
	const value = parseJsonValue(text, start, lines.branches, ctx)
	const node: JsonValueNode = {
		type: 'mcbuild:json_value',
		range: core.Range.create(start, end),
		targetType: type,
		children: [...(value ? [value] : []), ...lines.scripts],
	}
	if (value && value.type !== 'mcbuild:json_dynamic') {
		node.value = value
	}
	return { node, end }
}

/** A port of mc-build's line pass over JSON bodies (`parseJsonBody` / `parseJsonLines`). */
class JsonLines {
	readonly scripts: JsNode[] = []
	readonly branches: JsonBranch[] = []
	private readonly blanks: [number, number][] = []
	private readonly scanner = new JsonDepthScanner()
	private next: number
	private chains = 0

	constructor(
		private readonly fullText: string,
		start: number,
		private readonly ctx: core.ParserContext,
	) {
		this.next = start
	}

	/** Reads the whole value and returns where it ends. */
	read(): number {
		const first = this.nextLine()!
		const end = first.start + first.text.trimEnd().length
		if (first.text[0] !== '{' && first.text[0] !== '[') {
			return end
		}
		this.scanner.scan(first.text)
		if (this.scanner.depth <= 0) {
			return end
		}
		const closing = this.readLines(0, undefined)
		return closing
			? closing.line.start + closing.line.text.trimEnd().length
			: this.fullText.length
	}

	/** `fullText.slice(start, end)` with the blanked lines turned into spaces. */
	blankedText(start: number, end: number): string {
		let text = this.fullText.slice(start, end)
		for (const [from, to] of this.blanks) {
			const a = Math.max(from, start) - start
			const b = Math.min(to, end) - start
			if (a < b) {
				text = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b)
			}
		}
		return text
	}

	private nextLine(): Line | undefined {
		if (this.next > this.fullText.length) {
			return undefined
		}
		const newline = this.fullText.indexOf('\n', this.next)
		const end = newline === -1 ? this.fullText.length : newline
		const line = { start: this.next, end, text: this.fullText.slice(this.next, end) }
		this.next = end + 1
		return line
	}

	private peekLine(): string {
		const saved = this.next
		const line = this.nextLine()
		this.next = saved
		return line?.text.trim() ?? ''
	}

	private blank(line: Line): void {
		this.blanks.push([line.start, line.end])
	}

	private script(text: string, offset: number): void {
		const lead = text.length - text.trimStart().length
		this.scripts.push(parseJs(text.trim(), offset + lead, 'expression', this.ctx))
	}

	/**
	 * Reads lines until the depth drops back to `baseDepth`, or, inside the IF/ELSE/REPEAT
	 * block opened by `block`, until the line that closes it.
	 */
	private readLines(baseDepth: number, block: Line | undefined): Closing | undefined {
		while (true) {
			const line = this.nextLine()
			if (!line) {
				// An unclosed bracket is reported by the value parser.
				if (block) {
					this.ctx.err.report(
						localize('mcbuild.parser.json.unclosed-block'),
						core.Range.create(block.start, block.end),
					)
				}
				return undefined
			}
			const text = line.text.trim()
			const textStart = line.start + line.text.length - line.text.trimStart().length
			if (!this.scanner.inBlockComment) {
				if (text.startsWith('#')) {
					this.blank(line)
					continue
				}
				if (CONTROL_LINE.test(text) && text.endsWith('{')) {
					this.readControl(line, text, textStart)
					continue
				}
				if (block && text.startsWith('}') && this.scanner.depth === baseDepth) {
					this.blank(line)
					const rest = text.slice(1)
					return {
						text: rest.trim(),
						start: textStart + 1 + rest.length - rest.trimStart().length,
						line,
					}
				}
			}
			this.scanner.scan(line.text)
			if (this.scanner.depth < baseDepth) {
				this.ctx.err.report(
					localize(
						block
							? 'mcbuild.parser.json.closes-outside-block'
							: 'mcbuild.parser.json.unbalanced',
					),
					core.Range.create(textStart, textStart + text.length),
				)
				return block ? undefined : { text: '', start: line.end, line }
			}
			if (!block && this.scanner.depth === baseDepth) {
				return { text: '', start: line.end, line }
			}
		}
	}

	/** An IF/ELSE chain or a REPEAT whose header line is `line`. */
	private readControl(line: Line, text: string, textStart: number): void {
		this.blank(line)
		const header = text.slice(0, -1).trimEnd()
		const chain = this.chains++
		if (header.startsWith('REPEAT')) {
			this.script(header.replace(/\s+as\s+[\w$,\s]+$/, ''), textStart)
			const closing = this.readBranch(chain, 0, line)
			if (closing?.text) {
				this.reportAfterClose(closing)
			}
			return
		}
		this.script(header.slice('IF'.length), textStart + 'IF'.length)
		let closing = this.readBranch(chain, 0, line)
		for (let index = 1; closing; index++) {
			if (!closing.text) {
				if (!ELSE_LINE.test(this.peekLine())) {
					return
				}
				const next = this.nextLine()!
				this.blank(next)
				const trimmed = next.text.trim()
				closing = {
					text: trimmed,
					start: next.start + next.text.length - next.text.trimStart().length,
					line: next,
				}
			}
			if (!ELSE_LINE.test(closing.text) || !closing.text.endsWith('{')) {
				this.reportAfterClose(closing)
				return
			}
			const condition = closing.text.slice('ELSE'.length, -1)
			const condStart = closing.start + 'ELSE'.length
			const ifAt = condition.search(/\S/)
			if (condition.trimStart().startsWith('IF')) {
				this.script(condition.slice(ifAt + 'IF'.length), condStart + ifAt + 'IF'.length)
			}
			closing = this.readBranch(chain, index, closing.line)
		}
	}

	private readBranch(chain: number, index: number, header: Line): Closing | undefined {
		const closing = this.readLines(this.scanner.depth, header)
		this.branches.push({
			chain,
			index,
			start: header.end,
			end: closing ? closing.line.start : this.fullText.length,
		})
		return closing
	}

	private reportAfterClose(closing: Closing): void {
		this.ctx.err.report(
			localize('mcbuild.parser.json.after-close', localeQuote(closing.text)),
			core.Range.create(closing.start, closing.start + closing.text.length),
		)
	}
}
