import * as core from '@spyglassmc/core'

/** A {@link tokenize} token: mc-build's token kinds, with source ranges instead of line/col. */
export type McbToken = LiteralToken | BracketOpenToken | BracketCloseToken

interface BaseToken {
	/** Source span. For `\`-continued tokens use {@link BaseToken.indexMap} for sub-offsets. */
	range: core.Range
	/** Maps offsets in `value` / `data` to source offsets. */
	indexMap: core.IndexMap
}

export interface LiteralToken extends BaseToken {
	type: 'literal'
	/** The trimmed line content, with `\` continuations merged. */
	value: string
}

export interface BracketOpenToken extends BaseToken {
	type: 'bracket_open'

	value: '{'
	/** Trimmed text after the `{`, if any. */
	data: string | undefined
}

export interface BracketCloseToken extends BaseToken {
	type: 'bracket_close'
	value: '}'
}

/** A run of merged text that comes from one contiguous source region. */
interface Segment {
	/** Offset in the merged string. */
	at: number
	/** Offset in the source. */
	src: number
	len: number
}

class LineBuffer {
	/** Merged line text: indentation stripped, `\` continuations joined. */
	text = ''
	private readonly segments: Segment[] = []

	/** Appends `slice`, which starts at `srcStart` in the original source. */
	append(slice: string, srcStart: number): void {
		if (slice.length === 0) {
			return
		}
		this.segments.push({ at: this.text.length, src: srcStart, len: slice.length })
		this.text += slice
	}

	/** Removes the last `count` characters. */
	trimEnd(count: number): void {
		if (count <= 0) {
			return
		}
		this.text = this.text.slice(0, this.text.length - count)
		let remaining = count
		while (remaining > 0 && this.segments.length > 0) {
			const last = this.segments[this.segments.length - 1]
			if (last.len > remaining) {
				last.len -= remaining
				remaining = 0
			} else {
				remaining -= last.len
				this.segments.pop()
			}
		}
	}

	/** Maps an offset in {@link LineBuffer.text} to a source offset. */
	toSource(offset: number): number {
		if (this.segments.length === 0) {
			return offset
		}
		for (const seg of this.segments) {
			if (offset < seg.at + seg.len) {
				return seg.src + Math.max(0, offset - seg.at)
			}
		}
		const last = this.segments[this.segments.length - 1]
		return last.src + last.len + (offset - (last.at + last.len))
	}

	/**
	 * Range + index map for `text.slice(start, end)`. The map follows
	 * `core.concatOnTrailingBackslash`: one zero-width pair per `\` join.
	 */
	sliceLocation(start: number, end: number): { range: core.Range; indexMap: core.IndexMap } {
		const range = core.Range.create(this.toSource(start), this.toSource(end))
		// Base pair shifts slice-local offsets into the file.
		const indexMap: core.IndexMap = [{
			inner: core.Range.create(0),
			outer: core.Range.create(range.start),
		}]
		const crossing = this.segments.filter((seg) => seg.at < end && seg.at + seg.len > start)
		for (let i = 0; i < crossing.length - 1; i++) {
			const left = crossing[i]
			const right = crossing[i + 1]
			const innerJoin = left.at + left.len - start
			indexMap.push({
				inner: core.Range.create(innerJoin, innerJoin),
				outer: core.Range.create(left.src + left.len, right.src),
			})
		}
		return { range, indexMap }
	}
}

const INDENT_CHARS = new Set([' ', '\t'])

/**
 * Port of mc-build's `Tokenizer.tokenize`. Line-oriented: joins `\` lines,
 * toggles block comments on `###`, treats `}` as a bracket only at line start,
 * and finds the block-opening `{` right-to-left. Never throws.
 */
export function tokenize(source: string): McbToken[] {
	const rawLines = source.split('\n')

	const lines: { text: string; contentStart: number }[] = []
	let offset = 0
	for (const raw of rawLines) {
		let indent = 0
		while (indent < raw.length && INDENT_CHARS.has(raw.charAt(indent))) {
			indent++
		}
		lines.push({ text: raw.slice(indent), contentStart: offset + indent })
		offset += raw.length + 1 // +1 for the '\n' consumed by split
	}

	const tokens: McbToken[] = []
	let inBlockComment = false
	let lineIdx = 0

	while (lineIdx < lines.length) {
		const buf = new LineBuffer()
		buf.append(lines[lineIdx].text, lines[lineIdx].contentStart)

		while (true) {
			// CRLF leftovers.
			let trailingCr = 0
			while (
				buf.text.length - trailingCr > 0
				&& (buf.text.charAt(buf.text.length - 1 - trailingCr) === '\r'
					|| buf.text.charAt(buf.text.length - 1 - trailingCr) === '\n')
			) {
				trailingCr++
			}
			if (trailingCr > 0) {
				buf.trimEnd(trailingCr)
			}

			const trimmedLen = buf.text.length - (buf.text.length - buf.text.trimEnd().length)
			if (buf.text.trimEnd().endsWith('\\')) {
				buf.trimEnd(buf.text.length - trimmedLen + 1)
				const nextLine = lines[lineIdx + 1]
				if (nextLine === undefined) {
					break
				}
				const nextTrimmedStart = nextLine.text.length - nextLine.text.trimStart().length
				const nextTrimmed = nextLine.text.trim()
				buf.append(nextTrimmed, nextLine.contentStart + nextTrimmedStart)
				lineIdx++
			} else {
				break
			}
		}

		lineIdx++

		let line = buf.text

		if (line === '###') {
			inBlockComment = !inBlockComment
			continue
		}

		if (inBlockComment) {
			// mc-build prefixes block-comment lines with "### ".
			const loc = buf.sliceLocation(0, line.length)
			tokens.push({ type: 'literal', value: `### ${line}`, ...loc })
			continue
		}

		if (line.length > 0 && line.charAt(0) === '#') {
			const loc = buf.sliceLocation(0, line.length)
			tokens.push({ type: 'literal', value: line, ...loc })
			continue
		}

		/** Offset of `line` within the buffer text. */
		let scanBase = 0
		if (line.length > 0 && line.charAt(0) === '}') {
			const loc = buf.sliceLocation(0, 1)
			tokens.push({ type: 'bracket_close', value: '}', ...loc })
			line = line.slice(1)
			scanBase = 1
		}

		// Right-to-left scan for the block-opening `{`.
		let matchedOpeningBrace = false
		const braces: string[] = []
		for (let i = 0; i < line.length; i++) {
			const idx = line.length - i - 1
			const ch = line.charAt(idx)
			if (ch === '}') {
				braces.push('}')
			} else if (ch === '{') {
				if (braces.length === 0) {
					const contentRaw = line.slice(0, idx)
					const content = contentRaw.trim()
					if (content.length > 0) {
						const lead = contentRaw.length - contentRaw.trimStart().length
						const loc = buf.sliceLocation(
							scanBase + lead,
							scanBase + lead + content.length,
						)
						tokens.push({ type: 'literal', value: content, ...loc })
					}
					const braceInner = scanBase + idx
					const dataRaw = line.slice(idx + 1)
					const data = dataRaw.trim()
					const openLoc = buf.sliceLocation(braceInner, scanBase + line.length)
					if (data.length > 0) {
						const lead = dataRaw.length - dataRaw.trimStart().length
						const dataLoc = buf.sliceLocation(
							braceInner + 1 + lead,
							braceInner + 1 + lead + data.length,
						)
						tokens.push({
							type: 'bracket_open',
							value: '{',
							data,
							range: core.Range.span(openLoc.range, dataLoc.range),
							indexMap: dataLoc.indexMap,
						})
					} else {
						tokens.push({
							type: 'bracket_open',
							value: '{',
							data: undefined,
							range: core.Range.create(
								openLoc.range.start,
								openLoc.range.start + 1,
							),
							indexMap: [],
						})
					}
					matchedOpeningBrace = true
					break
				}
				braces.pop()
			}
		}

		const trimmed = line.trim()
		if (matchedOpeningBrace || trimmed.length === 0) {
			continue
		}

		const lead = line.length - line.trimStart().length
		const loc = buf.sliceLocation(scanBase + lead, scanBase + lead + trimmed.length)
		tokens.push({ type: 'literal', value: trimmed, ...loc })
	}

	return tokens
}
