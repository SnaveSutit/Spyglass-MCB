import * as core from '@spyglassmc/core'

/**
 * A `#>` doc block above a `function`, `clock` or `template`:
 *
 * ```
 * #> Shows a message to everyone in the queue
 * #
 * # @arg message {TextComponent} Text to show
 * # @deprecated Use ./broadcast
 * # @within ./queue/*
 * ```
 */
export interface DocComment {
	/** Markdown: the `#>` line plus any untagged lines. */
	text: string
	/** Macro arguments. */
	args: DocEntry[]
	/** Template parameters. */
	params: DocEntry[]
	/** The reason, or `''` when none is given. */
	deprecated?: string
	/** Intended callers. */
	within: string[]
}

export interface DocEntry {
	name: string
	type?: string
	desc: string
}

/** The doc block directly above `siblings[index]`, if any. Blank lines end a block. */
export function docCommentAbove(
	siblings: readonly core.AstNode[],
	index: number,
	text: string,
): DocComment | undefined {
	const lines: string[] = []
	let next = siblings[index]
	for (let i = index - 1; i >= 0; i--) {
		const node = siblings[i]
		if (!core.CommentNode.is(node) || node.prefix !== '#') {
			return undefined
		}
		const gap = text.slice(node.range.end, next.range.start)
		if (gap.split('\n').length > 2) {
			return undefined
		}
		lines.unshift(node.comment)
		if (node.comment.startsWith('>')) {
			return parseDocComment(lines)
		}
		next = node
	}
	return undefined
}

/** Parses comment lines with their `#` stripped, the first starting with `>`. */
export function parseDocComment(lines: readonly string[]): DocComment {
	const doc: DocComment = { text: '', args: [], params: [], within: [] }
	const text: string[] = []
	for (const [i, raw] of lines.entries()) {
		const line = i === 0 ? raw.slice(1).trim() : raw
		const tag = /^@(\w+)\s*(.*)$/.exec(line)
		switch (tag?.[1]) {
			case 'arg':
			case 'param': {
				const entry = parseEntry(tag[2])
				if (entry) {
					;(tag[1] === 'arg' ? doc.args : doc.params).push(entry)
				}
				break
			}
			case 'deprecated':
				doc.deprecated = tag[2].trim()
				break
			case 'within':
				if (tag[2].trim()) {
					doc.within.push(tag[2].trim())
				}
				break
			default:
				text.push(line)
		}
	}
	doc.text = text.join('\n').trim()
	return doc
}

/** `name {Type} description`, with the type optional. */
function parseEntry(text: string): DocEntry | undefined {
	const match = /^(\S+)\s*(?:\{([^}]*)\})?\s*(.*)$/.exec(text.trim())
	if (!match) {
		return undefined
	}
	return { name: match[1], type: match[2]?.trim() || undefined, desc: match[3].trim() }
}

/** Markdown for hover, shown below the symbol's signature. */
export function renderDocComment(doc: DocComment): string {
	const parts: string[] = []
	if (doc.deprecated !== undefined) {
		parts.push(`**Deprecated**${doc.deprecated ? `: ${doc.deprecated}` : ''}`)
	}
	if (doc.text) {
		parts.push(doc.text)
	}
	for (const [title, entries] of [['Arguments', doc.args], ['Parameters', doc.params]] as const) {
		if (entries.length > 0) {
			parts.push(`**${title}**\n${entries.map(renderEntry).join('\n')}`)
		}
	}
	if (doc.within.length > 0) {
		parts.push(`**Within**: ${doc.within.map((w) => `\`${w}\``).join(', ')}`)
	}
	return parts.join('\n\n')
}

function renderEntry({ name, type, desc }: DocEntry): string {
	return `- \`${name}\`${type ? `: \`${type}\`` : ''}${desc ? ` — ${desc}` : ''}`
}

/** A template param's `{Type}`: from the `with` overload's doc, else the template's. */
export function paramType(
	name: string,
	overloadDoc: DocComment | undefined,
	templateDoc: DocComment | undefined,
): string | undefined {
	return overloadDoc?.params.find((p) => p.name === name)?.type
		?? templateDoc?.params.find((p) => p.name === name)?.type
}

/** The doc stored on a function or template symbol by the binder. */
export function getDocComment(symbol: core.Symbol | undefined): DocComment | undefined {
	const doc = (symbol?.data as { doc?: DocComment } | undefined)?.doc
	return doc && Array.isArray(doc.args) ? doc : undefined
}
