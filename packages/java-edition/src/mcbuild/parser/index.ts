import * as core from '@spyglassmc/core'
import { localize } from '@spyglassmc/locales'
import type {
	BlockNode,
	BodyNode,
	ClockDefinitionNode,
	CompileTimeIfNode,
	CompileTimeLoopNode,
	DirectoryDefinitionNode,
	EntryNode,
	ExecuteBlockNode,
	ExecuteRunNode,
	FunctionCallNode,
	FunctionDefinitionNode,
	IdentifierNode,
	ImportNode,
	JsNode,
	JsonFileKind,
	JsonFileNode,
	LoadBlockNode,
	MacroPrefixNode,
	McbFileVariant,
	McbNode,
	MultilineScriptNode,
	ReferenceNode,
	ReferenceScheme,
	ReturnRunNode,
	ScheduleBlockNode,
	ScheduleCallNode,
	ScheduleClearNode,
	TagEntryNode,
	TemplateArgKind,
	TemplateArgNode,
	TemplateDefinitionNode,
	TemplateOverloadNode,
	TickBlockNode,
} from '../node/index.js'
import type { McbToken } from '../tokenizer.js'
import { tokenize } from '../tokenizer.js'
import type { CommandBridgeOptions } from './command.js'
import { parseCommandStatement, splitInterpolation, tokenSource } from './command.js'
import { parseEq } from './eq.js'
import { parseJs } from './js.js'
import { jsonFileType, parseJsonBody } from './json.js'
import { sliceToken, syntheticPrefixed, TokenReader } from './reader.js'

export type McbParserOptions = CommandBridgeOptions

const PLAIN_JSON_KINDS: Exclude<JsonFileKind, 'tag' | 'worldgen'>[] = [
	'advancement',
	'enchantment',
	'item_modifier',
	'loot_table',
	'predicate',
	'recipe',
	'chat_type',
	'damage_type',
	'dimension',
	'dimension_type',
]

export function entry(options: McbParserOptions): core.Parser<EntryNode> {
	return (src, ctx) => {
		const variant: McbFileVariant = ctx.doc.uri.endsWith('.mcbt')
			? 'mcbt'
			: 'mcb'
		const fullText = src.string
		const tokens = tokenize(fullText)
		const state = new ParseState(
			new TokenReader(tokens),
			ctx,
			options,
			fullText,
		)
		const node: EntryNode = {
			type: 'mcbuild:entry',
			range: core.Range.create(0, fullText.length),
			variant,
			children: [],
		}
		if (variant === 'mcbt') {
			state.parseMcbtFile(node.children)
		} else {
			state.parseMcbFile(node.children)
		}
		hideRedundantRefs(node)
		src.cursor = fullText.length
		return node
	}
}

/**
 * Node fields that alias entries in `children`. Made non-enumerable so snapshots
 * and tree walks don't visit each subtree twice.
 */
const REDUNDANT_REF_KEYS = new Set([
	'appendTo',
	'body',
	'command',
	'condition',
	'continuations',
	'data',
	'elifs',
	'entries',
	'execute',
	'expression',
	'holder',
	'id',
	'interpolation',
	'left',
	'params',
	'macro',
	'mode',
	'name',
	'objective',
	'operand',
	'operator',
	'overloads',
	'registry',
	'replace',
	'right',
	'script',
	'selector',
	'statement',
	'target',
	'time',
	'trailing',
	'value',
	'vars',
])

function hideRedundantRefs(node: core.AstNode): void {
	for (const key of REDUNDANT_REF_KEYS) {
		const desc = Object.getOwnPropertyDescriptor(node, key)
		if (!desc?.enumerable) {
			continue
		}
		const v = desc.value as unknown
		const isNode = !!v
			&& typeof v === 'object'
			&& typeof (v as core.AstNode).type === 'string'
			&& core.Range.is((v as core.AstNode).range)
		const isNodeArray = Array.isArray(v)
			&& v.every((e) => !!e && typeof (e as core.AstNode).type === 'string')
		// `elifs` wraps nodes that are already in `children`.
		const isElifs = key === 'elifs' && Array.isArray(v)
		if (isNode || isNodeArray || isElifs) {
			Object.defineProperty(node, key, { ...desc, enumerable: false })
		}
	}
	for (const child of node.children ?? []) {
		hideRedundantRefs(child)
	}
}

// #region helpers

function literalValue(token: McbToken | undefined): string | undefined {
	return token?.type === 'literal' ? token.value : undefined
}

/** Maps an offset in `token.value` to a document offset, across `\` continuations. */
function at(token: McbToken, offset: number): number {
	return core.IndexMap.toOuterOffset(token.indexMap, offset)
}

function subRange(token: McbToken, from: number, to: number): core.Range {
	return core.Range.create(at(token, from), at(token, to))
}

/** An identifier for `token.value.slice(from, to)`. */
function identAt(token: McbToken, from: number, to: number): IdentifierNode {
	return {
		type: 'mcbuild:identifier',
		range: subRange(token, from, to),
		value: token.value.slice(from, to),
	}
}

/** The trimmed `token.value.slice(from)` and its start offset. */
function restOf(token: McbToken, from: number): { text: string; start: number } {
	const raw = token.value.slice(from)
	return { text: raw.trim(), start: from + raw.length - raw.trimStart().length }
}

/** An identifier for the trimmed `token.value.slice(from)`. */
function restIdent(token: McbToken, from: number): IdentifierNode {
	const rest = restOf(token, from)
	return identAt(token, rest.start, rest.start + rest.text.length)
}

interface Word {
	text: string
	/** Offsets into `token.value`. */
	start: number
	end: number
}

/** Words of `token.value.slice(from)`. */
function wordsOf(token: McbToken, from = 0): Word[] {
	return [...token.value.slice(from).matchAll(/\S+/g)].map((m) => ({
		text: m[0],
		start: from + m.index,
		end: from + m.index + m[0].length,
	}))
}

const REPEAT_AS = /^(REPEAT\s*\([^]*\))\s+as\s+([\w$,\s]+)$/
/** mc-build's `executeRegExp`. */
const EXECUTE_RUN = /\brun\s+?\b/
const SCHEDULE_MODES = ['append', 'replace']

const TEMPLATE_ARG_KINDS: readonly TemplateArgKind[] = [
	'int',
	'float',
	'word',
	'raw',
	'js',
	'block',
	'literal',
]

// #endregion

class ParseState {
	constructor(
		private readonly reader: TokenReader,
		private readonly ctx: core.ParserContext,
		private readonly options: McbParserOptions,
		private readonly fullText: string,
	) {}

	private report(message: string, range: core.Range): void {
		this.ctx.err.report(message, range)
	}

	private unexpected(token: McbToken): core.ErrorNode {
		const message = token.type === 'literal'
			? localize('mcbuild.parser.unexpected-token', token.value)
			: token.type === 'bracket_open'
			? localize('mcbuild.parser.unexpected-open')
			: localize('mcbuild.parser.unexpected-close')
		this.report(message, token.range)
		return { type: 'error', range: token.range }
	}

	private eofRange(): core.Range {
		const end = this.reader.endOffset
		return core.Range.create(end, end)
	}

	// #region file level

	parseMcbFile(out: McbNode[]): void {
		while (this.reader.hasNext()) {
			const before = this.reader.peek()
			const node = this.parseTld()
			if (node) {
				out.push(node)
			}
			if (this.reader.peek() === before) {
				// No progress: drop the token.
				const stuck = this.reader.next()
				if (stuck) {
					out.push(this.unexpected(stuck))
				}
			}
		}
	}

	parseMcbtFile(out: McbNode[]): void {
		while (this.reader.hasNext()) {
			const token = this.reader.next()!
			const value = literalValue(token)
			if (value === undefined) {
				out.push(this.unexpected(token))
				continue
			}
			if (value.startsWith('#')) {
				out.push(this.comment(token))
			} else if (value.startsWith('template ')) {
				out.push(this.readTemplate(token))
			} else if (value.startsWith('import ')) {
				out.push(this.importStatement(token))
			} else {
				out.push(this.unexpected(token))
			}
		}
	}

	// #endregion
	// #region top-level declarations

	private parseTld(): McbNode | undefined {
		const token = this.reader.next()
		if (!token) {
			return undefined
		}
		if (token.type !== 'literal') {
			return this.unexpected(token)
		}
		const value = token.value

		if (value.startsWith('#')) {
			return this.comment(token)
		}
		if (value.startsWith('function ')) {
			return this.readFunction(token)
		}
		if (value.startsWith('clock ')) {
			return this.readClock(token)
		}
		if (value.startsWith('import ')) {
			return this.importStatement(token)
		}
		if (
			value.startsWith('dir ')
			&& this.reader.peek()?.type === 'bracket_open'
		) {
			return this.readDir(token)
		}
		if (value.startsWith('<%%')) {
			return this.multilineScript(token)
		}
		if (value.startsWith('REPEAT')) {
			return this.compileTimeLoop(token, () => this.parseTld())
		}
		if (value.startsWith('IF')) {
			return this.compileTimeIf(token, () => this.parseTld())
		}
		if (value.startsWith('tag ')) {
			return this.readTagFile(token)
		}
		if (value.startsWith('worldgen ')) {
			return this.readWorldgenFile(token)
		}
		for (const kind of PLAIN_JSON_KINDS) {
			if (value.startsWith(kind + ' ')) {
				return this.readPlainJsonFile(token, kind)
			}
		}
		return this.unexpected(token)
	}

	private readFunction(token: McbToken): FunctionDefinitionNode {
		const [name, tag] = wordsOf(token, 'function '.length)
		const id = name
			? identAt(token, name.start, name.end)
			: identAt(token, token.value.length, token.value.length)
		const node: FunctionDefinitionNode = {
			type: 'mcbuild:function_definition',
			range: token.range,
			id,
			children: [id],
		}
		if (tag) {
			const tagSrc = tokenSource(sliceToken(token, tag.start, tag.end))
			const appendTo = core.resourceLocation({
				category: 'tag/function',
				usageType: 'reference',
				allowTag: false,
			})(tagSrc, this.ctx)
			node.appendTo = appendTo
			node.children.push(appendTo)
		}
		node.body = this.block((body) => this.innerParse(body), false)
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		return node
	}

	private readClock(token: McbToken): ClockDefinitionNode {
		const payload = restOf(token, 'clock '.length)
		const spaceIdx = payload.text.indexOf(' ')
		let id: IdentifierNode
		let time: core.AstNode
		if (spaceIdx === -1) {
			this.report(
				localize('mcbuild.parser.clock.expected-name-time'),
				token.range,
			)
			id = restIdent(token, payload.start)
			time = { type: 'error', range: token.range }
		} else {
			id = identAt(token, payload.start, payload.start + spaceIdx)
			const timeStr = restOf(token, payload.start + spaceIdx)
			time = {
				type: 'mcbuild:time',
				range: subRange(token, timeStr.start, timeStr.start + timeStr.text.length),
			}
		}
		const node: ClockDefinitionNode = {
			type: 'mcbuild:clock_definition',
			range: token.range,
			id,
			time,
			children: [id, time],
		}
		node.body = this.block((body) => this.innerParse(body))
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		return node
	}

	private readDir(token: McbToken): DirectoryDefinitionNode {
		const id = restIdent(token, 'dir '.length)
		const node: DirectoryDefinitionNode = {
			type: 'mcbuild:directory_definition',
			range: token.range,
			id,
			children: [id],
		}
		node.body = this.block((body) => {
			const child = this.parseTld()
			if (child) {
				body.push(child)
			}
		}, false)
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		return node
	}

	private importStatement(token: McbToken): ImportNode {
		const path = restIdent(token, 'import '.length)
		return {
			type: 'mcbuild:import',
			range: token.range,
			path,
			children: [path],
		}
	}

	private comment(token: McbToken): core.CommentNode {
		const value = literalValue(token) ?? ''
		const prefix = value.startsWith('###') ? '###' : '#'
		return {
			type: 'comment',
			range: token.range,
			comment: value.slice(prefix.length).trim(),
			prefix,
		}
	}

	// #endregion
	// #region templates

	private readTemplate(token: McbToken): TemplateDefinitionNode {
		const id = restIdent(token, 'template '.length)
		const node: TemplateDefinitionNode = {
			type: 'mcbuild:template_definition',
			range: token.range,
			id,
			overloads: [],
			children: [id],
		}
		const body = this.block((entries) => {
			const child = this.innerParseTemplate()
			if (child) {
				entries.push(child)
				if (child.type === 'mcbuild:template_overload') {
					node.overloads.push(child)
				}
			}
		}, false)
		if (body) {
			node.children.push(...body.children)
			node.range = core.Range.span(token.range, body.range)
		}
		return node
	}

	private innerParseTemplate(): McbNode | undefined {
		const token = this.reader.peek()
		if (!token || token.type !== 'literal') {
			if (token) {
				this.reader.skip()
				return this.unexpected(token)
			}
			return undefined
		}
		const value = token.value
		if (value === 'load' || value === 'tick') {
			this.reader.skip()
			return this.tickLoad(token, value)
		}
		if (value === 'with' || value.startsWith('with ')) {
			this.reader.skip()
			return this.templateOverload(token)
		}
		if (value.startsWith('#')) {
			this.reader.skip()
			return this.comment(token)
		}
		this.reader.skip()
		return this.unexpected(token)
	}

	private templateOverload(token: McbToken): TemplateOverloadNode {
		const node: TemplateOverloadNode = {
			type: 'mcbuild:template_overload',
			range: token.range,
			params: [],
			children: [],
		}
		for (const word of wordsOf(token, 'with'.length)) {
			const colon = word.text.indexOf(':')
			let arg: TemplateArgNode
			if (colon === -1) {
				const nameNode = identAt(token, word.start, word.end)
				arg = {
					type: 'mcbuild:template_arg',
					range: nameNode.range,
					name: nameNode,
					kind: 'literal',
					children: [nameNode],
				}
			} else {
				const nameNode = identAt(token, word.start, word.start + colon)
				const kindStr = word.text.slice(colon + 1)
				const known = TEMPLATE_ARG_KINDS.includes(kindStr as TemplateArgKind)
				if (!known) {
					this.report(
						localize('mcbuild.parser.template.unknown-arg-kind', kindStr),
						subRange(token, word.start + colon + 1, word.end),
					)
				}
				arg = {
					type: 'mcbuild:template_arg',
					range: subRange(token, word.start, word.end),
					name: nameNode,
					kind: known ? (kindStr as TemplateArgKind) : 'raw',
					children: [nameNode],
				}
			}
			node.params.push(arg)
			node.children.push(arg)
		}
		node.body = this.block((body) => this.innerParse(body), false)
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		return node
	}

	private tickLoad(
		token: McbToken,
		kind: 'tick' | 'load',
	): TickBlockNode | LoadBlockNode {
		const node = {
			type: kind === 'tick' ? 'mcbuild:tick_block' : 'mcbuild:load_block',
			range: token.range,
			children: [] as core.AstNode[],
		} as TickBlockNode | LoadBlockNode
		node.body = this.block((body) => this.innerParse(body), false)
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		return node
	}

	// #endregion
	// #region function body statements

	private innerParse(out: McbNode[]): void {
		const token = this.reader.peek()
		if (!token) {
			return
		}
		if (token.type === 'bracket_open') {
			const block = this.anonymousBlock()
			out.push(block)
			return
		}
		if (token.type === 'bracket_close') {
			out.push(this.unexpected(this.reader.next()!))
			return
		}
		this.reader.skip()
		let value = token.value
		let macro: MacroPrefixNode | undefined
		if (value.startsWith('$')) {
			macro = { type: 'mcbuild:macro_prefix', range: subRange(token, 0, 1) }
			value = value.slice(1)
		}
		const shifted: McbToken = macro ? sliceToken(token, 1, token.value.length) : token

		if (value.startsWith('#')) {
			out.push(this.comment(token))
			return
		}
		if (value.startsWith('<%%')) {
			out.push(this.multilineScript(token))
			return
		}
		if (value.startsWith('IF')) {
			out.push(
				this.compileTimeIf(shifted, () => {
					const inner: McbNode[] = []
					this.innerParse(inner)
					return inner[0]
				}),
			)
			return
		}
		if (value.startsWith('REPEAT')) {
			out.push(
				this.compileTimeLoop(shifted, () => {
					const inner: McbNode[] = []
					this.innerParse(inner)
					return inner[0]
				}),
			)
			return
		}
		if (value === 'tick' || value === 'load') {
			out.push(this.tickLoad(token, value))
			return
		}
		if (value.startsWith('function ') || value === 'function') {
			out.push(this.functionCall(shifted, macro))
			return
		}
		if (value.startsWith('schedule ')) {
			out.push(this.schedule(shifted, macro))
			return
		}
		if (
			value.startsWith('execute')
			&& (value.length === 'execute'.length
				|| value['execute'.length] === ' '
				|| value['execute'.length] === '<')
		) {
			out.push(this.execute(shifted, macro))
			return
		}
		if (value === 'block' || value.startsWith('block ')) {
			out.push(this.blockStatement(shifted, macro))
			return
		}
		if (value.startsWith('return run')) {
			out.push(this.returnRun(shifted, macro))
			return
		}
		if (value.startsWith('eq ')) {
			out.push(this.eqStatement(shifted, macro))
			return
		}
		// A command or a template call; the checker decides which, so defer
		// command errors. A same-line `{ }` is a template block argument.
		const cmd = this.command(shifted, macro, true)
		const next = this.reader.peek()
		if (
			next?.type === 'bracket_open'
			&& this.sameLine(cmd.range.end, next.range.start)
		) {
			const block: BlockNode = {
				type: 'mcbuild:block',
				range: next.range,
				children: [],
			}
			block.body = this.block((body) => this.innerParse(body))
			if (block.body) {
				block.children.push(block.body)
				block.range = block.body.range
			}
			cmd.trailing = block
			cmd.children.push(block)
			cmd.range = core.Range.span(cmd.range, block.range)
		}
		out.push(cmd)
	}

	/** Whether no line break separates the two offsets. */
	private sameLine(from: number, to: number): boolean {
		return !this.fullText.slice(from, to).includes('\n')
	}

	private command(token: McbToken, macro?: MacroPrefixNode, deferCommandErrors = false) {
		const node = parseCommandStatement(
			token,
			this.options,
			this.ctx,
			deferCommandErrors,
		)
		if (macro) {
			node.macro = macro
			node.children.unshift(macro)
			node.range = core.Range.span(macro.range, node.range)
		}
		return node
	}

	/**
	 * Reports deferred `execute … run` errors, minus the "Expected more arguments"
	 * after a trailing `run` (mc-build fills it with the block's function).
	 */
	private replayExecuteErrors(
		cmd: { deferredErrors?: readonly core.LanguageError[] },
		token: McbToken,
	): void {
		const endsWithRun = /(^|\s)run$/.test(token.value.trimEnd())
		const eoc = localize('mcfunction.parser.eoc-unexpected')
		for (const e of cmd.deferredErrors ?? []) {
			if (endsWithRun && e.message === eoc) {
				continue
			}
			this.ctx.err.report(e.message, e.range, e.severity, e.info)
		}
		// Replayed here, so the command checker mustn't replay them again.
		delete cmd.deferredErrors
	}

	private anonymousBlock(): BlockNode {
		const open = this.reader.peek()!
		const node: BlockNode = {
			type: 'mcbuild:block',
			range: open.range,
			children: [],
		}
		node.body = this.block((body) => this.innerParse(body))
		if (node.body) {
			node.children.push(node.body)
			node.range = node.body.range
		}
		return node
	}

	private blockStatement(token: McbToken, macro?: MacroPrefixNode): BlockNode {
		const name = restOf(token, 'block'.length)
		const node: BlockNode = {
			type: 'mcbuild:block',
			range: token.range,
			macro,
			children: macro ? [macro] : [],
		}
		if (name.text.length > 0) {
			node.name = splitInterpolation(
				sliceToken(token, name.start, name.start + name.text.length),
				this.ctx,
			)
			node.children.push(...node.name)
		}
		node.body = this.block((body) => this.innerParse(body))
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(macro?.range ?? token.range, node.body.range)
		}
		return node
	}

	private functionCall(
		token: McbToken,
		macro?: MacroPrefixNode,
	): FunctionCallNode {
		const kwLen = 'function '.length
		const payload = token.value.slice(kwLen)
		const spaceIdx = payload.search(/\s/)
		const targetEnd = kwLen + (spaceIdx === -1 ? payload.length : spaceIdx)
		const target = this.referenceAt(token, kwLen, targetEnd)
		const node: FunctionCallNode = {
			type: 'mcbuild:function_call',
			range: token.range,
			macro,
			target,
			children: macro ? [macro, target] : [target],
		}
		if (spaceIdx !== -1) {
			const gap = payload.slice(spaceIdx).match(/^\s*/)![0].length
			const dataFrom = kwLen + spaceIdx + gap
			const dataStr = token.value.slice(dataFrom).trimEnd()
			const dataTo = dataFrom + dataStr.length
			if (dataStr.length > 0) {
				node.data = /^<%([^]*?)%>$/.test(dataStr)
					? parseJs(dataStr.slice(2, -2), at(token, dataFrom + 2), 'inline', this.ctx)
					: identAt(token, dataFrom, dataTo)
				node.children.push(node.data)
			}
		}
		node.range = core.Range.span(macro?.range ?? token.range, token.range)
		return node
	}

	private schedule(token: McbToken, macro?: MacroPrefixNode): McbNode {
		const words = wordsOf(token, 'schedule'.length)
		const prefix = macro ? [macro] : []

		if (words[0]?.text === 'clear' && words.length > 1) {
			const target = restOf(token, words[0].end)
			const ref = this.referenceAt(token, target.start, target.start + target.text.length)
			return {
				type: 'mcbuild:schedule_clear',
				range: token.range,
				macro,
				target: ref,
				children: [...prefix, ref],
			} satisfies ScheduleClearNode
		}

		if (words[0]?.text === 'function' && words.length > 1) {
			const ref = this.referenceAt(token, words[1].start, words[1].end)
			const { time, mode } = this.scheduleTiming(token, words.slice(2), words[1].end)
			if (time.range.start === time.range.end) {
				this.report(localize('mcbuild.parser.schedule.expected-delay'), token.range)
			}
			return {
				type: 'mcbuild:schedule_call',
				range: token.range,
				macro,
				target: ref,
				time,
				mode,
				children: [...prefix, ref, time, ...(mode ? [mode] : [])],
			} satisfies ScheduleCallNode
		}

		const { time, mode } = this.scheduleTiming(token, words, token.value.length)
		const node: ScheduleBlockNode = {
			type: 'mcbuild:schedule_block',
			range: token.range,
			macro,
			time,
			mode,
			children: [...prefix, time, ...(mode ? [mode] : [])],
		}
		node.body = this.block((body) => this.innerParse(body))
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(macro?.range ?? token.range, node.body.range)
		}
		return node
	}

	/** Splits words into a delay and a trailing `append` / `replace` (only after a delay). */
	private scheduleTiming(
		token: McbToken,
		words: Word[],
		fallback: number,
	): { time: core.AstNode; mode?: IdentifierNode } {
		const last = words[words.length - 1]
		const mode = words.length > 1 && SCHEDULE_MODES.includes(last.text)
			? identAt(token, last.start, last.end)
			: undefined
		const delay = mode ? words.slice(0, -1) : words
		const range = delay.length > 0
			? subRange(token, delay[0].start, delay[delay.length - 1].end)
			: core.Range.create(at(token, fallback))
		return { time: { type: 'mcbuild:time', range }, mode }
	}

	private execute(token: McbToken, macro?: MacroPrefixNode): McbNode {
		const match = EXECUTE_RUN.exec(token.value)
		// Block form, unless the `{` belongs to an inline statement after `run`
		// (`execute as @a run schedule 1t {`), like mc-build.
		if (
			this.reader.peek()?.type === 'bracket_open'
			&& (token.value.endsWith('run') || !match)
		) {
			const executeCmd = this.command(token, undefined, true)
			this.replayExecuteErrors(executeCmd, token)
			const node: ExecuteBlockNode = {
				type: 'mcbuild:execute_block',
				range: core.Range.span(macro?.range ?? token.range, token.range),
				macro,
				execute: executeCmd,
				continuations: [],
				children: [...(macro ? [macro] : []), executeCmd],
			}
			node.body = this.block((body) => this.innerParse(body))
			if (node.body) {
				node.children.push(node.body)
				node.range = core.Range.span(node.range, node.body.range)
			}
			this.parseExecuteContinuations(node)
			return node
		}

		if (match) {
			const head = sliceToken(token, 0, match.index + 'run'.length)
			const executeCmd = this.command(head, undefined, true)
			this.replayExecuteErrors(executeCmd, head)
			const tail = restOf(token, match.index + match[0].length)
			this.reader.insert(sliceToken(token, tail.start, token.value.length))
			const inner: McbNode[] = []
			this.innerParse(inner)
			const node: ExecuteRunNode = {
				type: 'mcbuild:execute_run',
				range: core.Range.span(
					macro?.range ?? token.range,
					inner[0]?.range ?? token.range,
				),
				macro,
				execute: executeCmd,
				statement: inner[0],
				children: [
					...(macro ? [macro] : []),
					executeCmd,
					...(inner[0] ? [inner[0]] : []),
				],
			}
			return node
		}

		return this.command(token, macro)
	}

	private parseExecuteContinuations(node: ExecuteBlockNode): void {
		while (this.reader.hasNext()) {
			const peek = this.reader.peek()
			const text = literalValue(peek)
			if (text === undefined) {
				break
			}
			if (text === 'else run' || text === 'else $run') {
				this.reader.skip()
				const block: BlockNode = {
					type: 'mcbuild:block',
					range: peek!.range,
					children: [],
				}
				block.body = this.block((body) => this.innerParse(body))
				if (block.body) {
					block.children.push(block.body)
					block.range = core.Range.span(peek!.range, block.body.range)
				}
				node.continuations.push(block)
				node.children.push(block)
				continue
			}
			if (text.startsWith('else ') && text.endsWith('run')) {
				this.reader.skip()
				const isMacro = text.startsWith('else $')
				const exec = restOf(peek!, isMacro ? 'else $'.length : 'else '.length)
				// mc-build omits the leading `execute` here.
				const execToken = exec.text.startsWith('execute ')
					? sliceToken(peek!, exec.start, text.length)
					: syntheticPrefixed('execute ', exec.text, subRange(peek!, exec.start, text.length))
				const executeCmd = this.command(execToken, undefined, true)
				this.replayExecuteErrors(executeCmd, execToken)
				const cont: ExecuteBlockNode = {
					type: 'mcbuild:execute_block',
					range: peek!.range,
					execute: executeCmd,
					continuations: [],
					children: [executeCmd],
				}
				cont.body = this.block((body) => this.innerParse(body))
				if (cont.body) {
					cont.children.push(cont.body)
					cont.range = core.Range.span(peek!.range, cont.body.range)
				}
				node.continuations.push(cont)
				node.children.push(cont)
				continue
			}
			break
		}
	}

	private returnRun(token: McbToken, macro?: MacroPrefixNode): ReturnRunNode {
		const afterKw = token.value.slice('return run'.length)
		const rest = afterKw.replace(/^\s+/, '')
		const restFrom = 'return run'.length + (afterKw.length - rest.length)
		const node: ReturnRunNode = {
			type: 'mcbuild:return_run',
			range: core.Range.span(macro?.range ?? token.range, token.range),
			macro,
			children: macro ? [macro] : [],
		}
		const next = this.reader.peek()
		if (rest.length === 0 && next?.type === 'bracket_open') {
			const block: BlockNode = {
				type: 'mcbuild:block',
				range: next.range,
				children: [],
			}
			block.body = this.block((body) => this.innerParse(body))
			if (block.body) {
				block.children.push(block.body)
				block.range = block.body.range
			}
			node.value = block
			node.children.push(block)
			node.range = core.Range.span(node.range, block.range)
			return node
		}
		if (rest.length === 0) {
			this.report(localize('mcbuild.parser.return-run.expected'), node.range)
			return node
		}
		this.reader.insert(sliceToken(token, restFrom, token.value.length))
		const inner: McbNode[] = []
		this.innerParse(inner)
		node.value = inner[0]
		if (inner[0]) {
			node.children.push(inner[0])
			node.range = core.Range.span(node.range, inner[0].range)
		}
		return node
	}

	private eqStatement(token: McbToken, macro?: MacroPrefixNode): McbNode {
		const from = 'eq '.length
		const stmt = parseEq(
			token.value.slice(from),
			(offset) => at(token, from + offset),
			token.range,
			this.ctx,
		)
		if (!stmt) {
			return { type: 'error', range: token.range }
		}
		if (macro) {
			stmt.range = core.Range.span(macro.range, stmt.range)
			stmt.children.unshift(macro)
		}
		return stmt
	}

	private multilineScript(token: McbToken): MultilineScriptNode {
		// The tokenizer splits the script's braces into bracket tokens, so skip
		// everything up to `%%>` and read the JS straight from the document.
		const scriptStart = at(token, '<%%'.length)
		let close: McbToken | undefined
		while (this.reader.hasNext()) {
			const peek = this.reader.peek()!
			if (peek.type === 'literal' && peek.value.trimEnd() === '%%>') {
				close = this.reader.next()
				break
			}
			this.reader.next()
		}
		const scriptEnd = close ? close.range.start : this.reader.endOffset
		if (!close) {
			this.report(localize('mcbuild.parser.script.unterminated'), token.range)
		}
		const jsSource = this.fullText.slice(scriptStart, scriptEnd)
		const script = parseJs(jsSource, scriptStart, 'multiline', this.ctx)
		script.range = core.Range.create(scriptStart, scriptEnd)
		return {
			type: 'mcbuild:multiline_script',
			range: core.Range.create(token.range.start, close?.range.end ?? scriptEnd),
			script,
			children: [script],
		}
	}

	// #endregion
	// #region control flow

	private compileTimeIf(
		token: McbToken,
		parseChild: () => McbNode | undefined,
	): CompileTimeIfNode {
		const expr = restOf(token, 'IF'.length)
		const condition = this.js(expr.text, at(token, expr.start))
		const node: CompileTimeIfNode = {
			type: 'mcbuild:compiletime_if',
			range: token.range,
			condition,
			elifs: [],
			children: [condition],
		}
		node.body = this.block((body) => {
			const child = parseChild()
			if (child) {
				body.push(child)
			}
		}, false)
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		while (this.reader.hasNext()) {
			const peek = this.reader.peek()
			const text = literalValue(peek)
			if (
				text === undefined
				|| (text !== 'ELSE' && !text.startsWith('ELSE '))
			) {
				break
			}
			this.reader.skip()
			let elifCond: JsNode | undefined
			if (text.startsWith('ELSE ')) {
				let cond = restOf(peek!, 'ELSE '.length)
				if (cond.text.startsWith('IF')) {
					cond = restOf(peek!, cond.start + 'IF'.length)
				}
				elifCond = this.js(cond.text, at(peek!, cond.start))
			}
			const elif: { condition?: JsNode; body?: BodyNode } = {
				condition: elifCond,
			}
			elif.body = this.block((body) => {
				const child = parseChild()
				if (child) {
					body.push(child)
				}
			}, false)
			node.elifs.push(elif)
			if (elifCond) {
				node.children.push(elifCond)
			}
			if (elif.body) {
				node.children.push(elif.body)
				node.range = core.Range.span(node.range, elif.body.range)
			}
		}
		return node
	}

	private compileTimeLoop(
		token: McbToken,
		parseChild: () => McbNode | undefined,
	): CompileTimeLoopNode {
		const value = token.value
		const asMatch = REPEAT_AS.exec(value)
		const vars: IdentifierNode[] = []
		if (asMatch) {
			const varsFrom = value.length - asMatch[2].length
			for (const m of asMatch[2].matchAll(/[\w$]+/g)) {
				vars.push(identAt(token, varsFrom + m.index, varsFrom + m.index + m[0].length))
			}
		}
		const expression = this.js(asMatch?.[1] ?? value, at(token, 0))
		const node: CompileTimeLoopNode = {
			type: 'mcbuild:compiletime_loop',
			range: token.range,
			expression,
			vars,
			children: [expression, ...vars],
		}
		node.body = this.block((body) => {
			const child = parseChild()
			if (child) {
				body.push(child)
			}
		})
		if (node.body) {
			node.children.push(node.body)
			node.range = core.Range.span(token.range, node.body.range)
		}
		return node
	}

	private js(text: string, base: number): JsNode {
		return parseJs(text, base, 'expression', this.ctx)
	}

	// #endregion
	// #region data files

	private readTagFile(token: McbToken): JsonFileNode {
		const [registry, id, replace] = this.headerWords(token, 'tag '.length, 3)
		const node: JsonFileNode = {
			type: 'mcbuild:json_file',
			range: token.range,
			kind: 'tag',
			registry,
			id,
			entries: [],
			children: [registry, id],
		}
		if (replace.value === 'replace') {
			node.replace = { type: 'mcbuild:keyword', range: replace.range }
			node.children.push(node.replace)
		}
		const body = this.block((entries) => {
			const entry = this.tagEntry()
			if (entry) {
				entries.push(entry)
			}
		})
		if (body) {
			node.entries = body.children as TagEntryNode[]
			node.children.push(...body.children)
			node.range = core.Range.span(token.range, body.range)
		}
		return node
	}

	private tagEntry(): TagEntryNode | undefined {
		const token = this.reader.peek()
		if (!token || token.type !== 'literal') {
			if (token) {
				this.reader.skip()
			}
			return undefined
		}
		this.reader.skip()
		let text = token.value
		let replace: core.AstNode | undefined
		if (text.endsWith(' replace')) {
			const idx = text.length - 'replace'.length
			replace = {
				type: 'mcbuild:keyword',
				range: subRange(token, idx, text.length),
			}
			text = text.slice(0, idx).trimEnd()
		}
		const value: TagEntryNode['value'] = /^<%([^]*?)%>$/.test(text)
			? parseJs(text.slice(2, -2), at(token, 2), 'inline', this.ctx)
			: this.referenceAt(token, 0, text.length)
		const node: TagEntryNode = {
			type: 'mcbuild:tag_entry',
			range: token.range,
			value,
			replace,
			children: [value],
		}
		if (replace) {
			node.children.push(replace)
		}
		return node
	}

	private readWorldgenFile(token: McbToken): JsonFileNode {
		const [registry, id] = this.headerWords(token, 'worldgen '.length, 2)
		return this.finishJsonFile(token, 'worldgen', registry, id, registry.value)
	}

	private readPlainJsonFile(token: McbToken, kind: JsonFileKind): JsonFileNode {
		const [id] = this.headerWords(token, kind.length + 1, 1)
		return this.finishJsonFile(token, kind, undefined, id, undefined)
	}

	private finishJsonFile(
		token: McbToken,
		kind: JsonFileKind,
		registry: IdentifierNode | undefined,
		id: IdentifierNode,
		registryValue: string | undefined,
	): JsonFileNode {
		const node: JsonFileNode = {
			type: 'mcbuild:json_file',
			range: token.range,
			kind,
			registry,
			id,
			entries: [],
			children: registry ? [registry, id] : [id],
		}
		const open = this.reader.peek()
		if (open?.type !== 'bracket_open') {
			this.report(localize('mcbuild.parser.expected-block'), token.range)
			return node
		}
		const close = this.consumeBalancedBlock()
		if (!close) {
			return node
		}
		const bodyStart = open.range.start
		const bodyEnd = close.range.end
		const text = this.fullText.slice(bodyStart, bodyEnd)
		const type = jsonFileType(kind, registryValue)
		const body = parseJsonBody(
			text,
			core.Range.create(bodyStart, bodyEnd),
			type,
			this.ctx,
		)
		node.entries = [body]
		node.children.push(body)
		node.range = core.Range.span(token.range, core.Range.create(bodyEnd))
		return node
	}

	/** Skips past the next `{ … }`, returning the `}` token. */
	private consumeBalancedBlock(): McbToken | undefined {
		const open = this.reader.next()
		if (open?.type !== 'bracket_open') {
			return undefined
		}
		let depth = 1
		while (this.reader.hasNext()) {
			const token = this.reader.next()!
			if (token.type === 'bracket_open') {
				depth++
			} else if (token.type === 'bracket_close') {
				depth--
				if (depth === 0) {
					return token
				}
			}
		}
		this.report(localize('mcbuild.parser.unexpected-eof'), this.eofRange())
		return undefined
	}

	/** The first `count` words after `from`; missing ones are empty at end of line. */
	private headerWords(token: McbToken, from: number, count: number): IdentifierNode[] {
		const words = wordsOf(token, from)
		const end = token.value.length
		return Array.from(
			{ length: count },
			(_, i) =>
				words[i] ? identAt(token, words[i].start, words[i].end) : identAt(token, end, end),
		)
	}

	// #endregion
	// #region references

	private referenceAt(token: McbToken, from: number, to: number): ReferenceNode {
		const text = token.value.slice(from, to)
		let isTag = false
		let body = text
		if (body.startsWith('#')) {
			isTag = true
			body = body.slice(1)
		}
		let scheme: ReferenceScheme = 'id'
		let depth: number | undefined
		let path = body
		if (body.startsWith('*')) {
			scheme = 'absolute'
			path = body.slice(1)
		} else if (body.startsWith('./') || body.startsWith('../')) {
			scheme = 'relative'
		} else if (/^\^\d+/.test(body)) {
			scheme = 'parent'
			const m = /^\^(\d+)/.exec(body)!
			depth = Number.parseInt(m[1], 10)
			path = body.slice(m[0].length)
		} else if (body.includes(':')) {
			scheme = 'id'
		} else {
			scheme = 'relative'
		}
		return {
			type: 'mcbuild:reference',
			range: subRange(token, from, to),
			scheme,
			isTag,
			depth,
			path,
		}
	}

	// #endregion
	// #region block bodies

	/** Parses a `{ … }` body, calling `sub` per child. `undefined` if there's no `{`. */
	private block(
		sub: (out: McbNode[]) => void,
		allowData = true,
	): BodyNode | undefined {
		const open = this.reader.peek()
		if (open?.type !== 'bracket_open') {
			this.report(
				localize('mcbuild.parser.expected-block'),
				this.reader.peek()?.range ?? this.eofRange(),
			)
			return undefined
		}
		this.reader.skip()
		const body: BodyNode = {
			type: 'mcbuild:body',
			range: open.range,
			children: [],
		}
		if (open.data !== undefined) {
			if (!allowData) {
				this.report(
					localize('mcbuild.parser.unexpected-block-data'),
					open.range,
				)
			}
			body.data = /^<%([^]*?)%>$/.test(open.data)
				? parseJs(open.data.slice(2, -2), at(open, 2), 'inline', this.ctx)
				: {
					type: 'mcbuild:identifier',
					range: subRange(open, 0, open.data.length),
					value: open.data,
				}
		}
		while (this.reader.hasNext()) {
			const peek = this.reader.peek()!
			if (peek.type === 'bracket_close') {
				this.reader.skip()
				body.range = core.Range.span(open.range, peek.range)
				return body
			}
			const before = this.reader.peek()
			sub(body.children)
			if (this.reader.peek() === before) {
				const stuck = this.reader.next()
				if (stuck) {
					body.children.push(this.unexpected(stuck))
				}
			}
		}
		this.report(localize('mcbuild.parser.unexpected-eof'), this.eofRange())
		body.range = core.Range.create(open.range.start, this.reader.endOffset)
		return body
	}

	// #endregion
}
