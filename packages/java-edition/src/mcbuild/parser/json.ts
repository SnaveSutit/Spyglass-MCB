import * as core from '@spyglassmc/core'
import * as json from '@spyglassmc/json'
import { localize } from '@spyglassmc/locales'
import * as mcdoc from '@spyglassmc/mcdoc'
import type { JsonFileKind } from '../node/index.js'

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
			return registry
				? {
					kind: 'dispatcher',
					registry: 'minecraft:resource',
					parallelIndices: [{ kind: 'static', value: `worldgen/${registry}` }],
				}
				: undefined
		default:
			return {
				kind: 'dispatcher',
				registry: 'minecraft:resource',
				parallelIndices: [{ kind: 'static', value: kind }],
			}
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

export interface JsonBodyExtent {
	/** End of the line that closes the root bracket. */
	end: number
	/** The body's source, with mc-build's `#` comment lines blanked out to keep offsets. */
	text: string
}

/**
 * Finds the JSON body starting at the `{` or `[` at `start`, line by line like mc-build:
 * the body ends with the line that brings the bracket depth back to zero.
 * Returns `undefined` if the file ends first.
 */
export function jsonBodyExtent(fullText: string, start: number): JsonBodyExtent | undefined {
	const scanner = new JsonDepthScanner()
	let text = ''
	let lineStart = start
	while (lineStart <= fullText.length) {
		const newline = fullText.indexOf('\n', lineStart)
		const lineEnd = newline === -1 ? fullText.length : newline
		const line = fullText.slice(lineStart, lineEnd)
		const isComment = lineStart !== start && !scanner.inBlockComment
			&& line.trimStart().startsWith('#')
		if (isComment) {
			text += ' '.repeat(line.length)
		} else {
			text += line
			scanner.scan(line)
			if (scanner.depth <= 0) {
				return { end: lineStart + line.trimEnd().length, text: text.trimEnd() }
			}
		}
		if (newline === -1) {
			return undefined
		}
		text += '\n'
		lineStart = newline + 1
	}
	return undefined
}

/** Parses a JSON body, wrapped in `json:typed` when `type` is known. */
export function parseJsonBody(
	text: string,
	range: core.Range,
	type: mcdoc.McdocType | undefined,
	ctx: core.ParserContext,
): core.AstNode {
	const src = new core.Source(text, [{
		inner: core.Range.create(0),
		outer: core.Range.create(range.start),
	}])
	const result = json.parser.entry(src, ctx)
	if (result === core.Failure) {
		ctx.err.report(localize('mcbuild.parser.json.invalid'), range)
		return { type: 'error', range }
	}
	if (src.skipWhitespace().canReadInLine()) {
		ctx.err.report(
			localize('mcbuild.parser.json.trailing'),
			core.Range.create(src.cursor, range.end),
		)
	}
	if (!type) {
		return result
	}
	const typed: json.TypedJsonNode = {
		type: 'json:typed',
		range: result.range,
		children: [result],
		targetType: type,
	}
	return typed
}
