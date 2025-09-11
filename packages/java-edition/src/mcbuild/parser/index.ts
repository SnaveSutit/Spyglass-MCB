import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { RootTreeNode } from '@spyglassmc/mcfunction'
import * as mcf from '@spyglassmc/mcfunction'
import * as nbt from '@spyglassmc/nbt'
import type { EntityNode } from '../../mcfunction/node'
import { argument, entity, selector, vector } from '../../mcfunction/parser'
import type {
	MCBDirContextNode,
	MCBDirectoryDefinitionNode,
	MCBFunctionBlockArgumentsNode,
	MCBFunctionBlockNode,
	MCBFunctionDefinitionNode,
	MCBInlineJSBlock,
	MCBJSBlockCommand,
	MCBMultilineJSBlock,
	MCBNode,
	MCBStringWithInlineJSBlock,
	MCBVanillaCommand,
} from '../node'

const FUNCTION_NAME_CHARS = new Set(
	'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.'.split(''),
)
const BLOCK_NAME_CHARS = new Set([...FUNCTION_NAME_CHARS, '/'])
const LINE_CONTAINS_INLINE_JS_BLOCK = /<%(.+?)%>/

function skipUntil(...terminators: string[]): core.Parser<undefined> {
	return (src, ctx) => {
		while (src.canRead()) {
			for (const term of terminators) {
				if (src.tryPeek(term)) {
					return undefined
				}
			}
			src.skip()
		}
		return undefined
	}
}

function attempt(parser: core.Parser<core.AstNode>): core.Parser<core.AstNode> {
	return (src, ctx) => {
		const { result, updateSrcAndCtx } = core.attempt(parser, src, ctx)
		if (result === core.Failure) {
			return core.Failure
		}
		updateSrcAndCtx()
		return result
	}
}

function reportOnFail<
	N extends core.Returnable,
	T extends core.Parser<N> | core.InfallibleParser<N>,
>(
	parser: T,
	message: string,
): T {
	return ((src, ctx) => {
		const result = parser(src, ctx)
		if (result === core.Failure) {
			ctx.err.report(message, src)
		}
		return result
	}) as T
}

function debug<
	N extends core.Returnable,
	T extends core.Parser<N> | core.InfallibleParser<N>,
>(
	parser: T,
	preParse?: (parser: T, src: core.Source, ctx: core.ParserContext) => void,
	postParse?: (res: core.Result<N>, src: core.Source, ctx: core.ParserContext) => void,
): T {
	return ((src, ctx) => {
		preParse?.(parser, src, ctx)
		const res = parser(src, ctx)
		postParse?.(res, src, ctx)
		return res
	}) as T
}

function comment(): core.Parser<core.CommentNode> {
	return (src, ctx) => {
		const res = core.comment({
			singleLinePrefixes: new Set(['#']),
		})(src, ctx)
		if (res === core.Failure) {
			return core.Failure
		} else if (res.comment.match(LINE_CONTAINS_INLINE_JS_BLOCK)) {
			const commentSrc = new core.Source(src.string.slice(0, src.cursor + res.comment.length))
			commentSrc.cursor = src.cursor - res.comment.length

			const blocks = core.repeat(
				core.sequence([
					skipUntil('<%', core.LF, core.CR),
					core.failOnEmpty(inlineJSBlock()),
				]),
			)(commentSrc, ctx)

			if (blocks.children.length === 0) {
				ctx.err.report(
					localize('expected', 'inline JS block in comment after matching regex (Bug)'),
					src,
				)
			}
			res.children = blocks.children
		}
		return res
	}
}

function argumentSeparator<T extends undefined = undefined>(
	returnValue?: T,
): core.InfallibleParser<T>
function argumentSeparator<T extends core.AstNode[] = []>(
	returnValue?: T,
): core.InfallibleParser<T>
function argumentSeparator<T extends ([] | undefined) = undefined>(
	returnValue?: T,
): core.InfallibleParser<T> {
	return core.map(mcf.sep, () => {
		return returnValue as T
	})
}

function syntaxGap(allowComments = true): core.InfallibleParser<core.CommentNode[]> {
	return (src: core.Source, ctx: core.ParserContext): core.CommentNode[] => {
		const ans: core.CommentNode[] = []

		src.skipWhitespace()
		if (allowComments) {
			while (src.canRead() && src.peek() === '#') {
				const result = comment()(src, ctx) as core.CommentNode
				ans.push(result)
				src.skipWhitespace()
			}
		}

		return ans
	}
}

function optionalSequence<
	GN extends core.AstNode = never,
	PA extends core.SP<core.AstNode>[] = core.SP<core.AstNode>[],
>(
	parsers: core.SP<core.AstNode>[],
	parseGap?: core.InfallibleParser<core.AstNode[]>,
): core.Parser<core.SequenceUtil<core.AstNode> | undefined> {
	return core.optional(core.sequence(parsers, parseGap))
}

function expectEOL(): core.InfallibleParser<undefined> {
	return (src, ctx) => {
		src.skipSpace()
		if (src.canReadInLine()) {
			ctx.err.report(localize('expected', 'End of Line'), src)
		}
	}
}

/**
 * A parser that checks if the cursor is at the end of the line.
 * @returns `undefined` if the cursor is at the end of the line, otherwise `core.Failure`.
 */
function isEOL(): core.Parser<undefined> {
	return (src, ctx) => {
		if (src.canReadInLine()) {
			return core.Failure
		}
		return undefined
	}
}

function punctuation(punctuation: string): core.Parser<core.AstNode> {
	return (src, ctx) => {
		if (!src.trySkip(punctuation)) {
			ctx.err.report(
				localize(
					'expected-got',
					localeQuote(punctuation),
					localeQuote(src.peek(punctuation.length)),
				),
				src,
			)
			return core.Failure
		}
		return {
			type: 'punctuation',
			range: core.Range.create(src.cursor - punctuation.length, src.cursor),
			value: punctuation,
		}
	}
}

function inlineJSBlock(): core.Parser<MCBInlineJSBlock> {
	const parser = core.setType(
		'mcbuild:inline_js_block',
		core.sequence([
			punctuation('<%'),
			core.stopBefore(
				// TODO: Swap out string for the JS parser
				core.string({
					unquotable: {
						allowEmpty: true,
					},
				}),
				'<%',
				'%>',
				core.LF,
				core.CR,
			),
			punctuation('%>'),
		]),
	)
	return (src, ctx) => {
		const result = parser(src, ctx) as core.Result<MCBInlineJSBlock>
		if (result === core.Failure) {
			return result
		}
		result.hover = 'Inline JS Block'
		return result
	}
}

function stringWithJSBlockSupport(
	options: {
		unquotable: Exclude<core.StringOptions['unquotable'], boolean | undefined>
	},
): core.InfallibleParser<MCBStringWithInlineJSBlock> {
	return core.setType(
		'mcbuild:string_with_inline_js_block',
		core.repeat(
			core.any([
				core.failOnEmpty(
					core.stopBefore(
						core.string(options),
						'<%',
						core.LF,
						core.CR,
					),
				),
				core.failOnError(core.failOnEmpty(inlineJSBlock())),
			]),
		),
	)
}

function multilineJSBlock(): core.Parser<MCBMultilineJSBlock> {
	return core.setType(
		'mcbuild:multiline_js_block',
		core.sequence([
			punctuation('<%%'),
			// TODO: Swap out string for the JS parser
			core.stopBefore(
				core.string({
					unquotable: {
						allowEmpty: true,
					},
				}),
				'<%%',
				'%%>',
			),
			punctuation('%%>'),
		]),
	)
}

function jsBlockCommand(): core.InfallibleParser<MCBJSBlockCommand> {
	return core.setType(
		'mcbuild:js_block_command',
		stringWithJSBlockSupport({
			unquotable: {
				allowEmpty: true,
			},
		}),
	)
}

function commandContext(
	commandTree: mcf.RootTreeNode,
	argument: mcf.ArgumentParserGetter,
	options: mcf.McfunctionOptions,
): core.Parser<core.AstNode> {
	return (src, ctx) => {
		const ans: MCBVanillaCommand = {
			type: 'mcbuild:vanilla_command',
			range: core.Range.create(src),
			children: [],
		}

		if (src.peekLine().match(/<%(.+?)%>/)) {
			ans.children.push(jsBlockCommand()(src, ctx))
		} else {
			ans.children.push(mcf.command(commandTree, argument, options.commandOptions)(src, ctx))
		}

		ans.range.end = src.cursor

		return ans
	}
}

function functionContext(
	commandTree: mcf.RootTreeNode,
	argument: mcf.ArgumentParserGetter,
	options: mcf.McfunctionOptions,
): core.Parser<MCBFunctionBlockNode> {
	const parser = commandContext(commandTree, argument, options)
	const command = options.lineContinuation ? core.concatOnTrailingBackslash(parser) : parser

	return (src, ctx) => {
		const ans: MCBFunctionBlockNode = {
			type: 'mcbuild:function_block',
			range: core.Range.create(src),
			children: [],
		}

		while (src.skipWhitespace().canReadInLine()) {
			let result: core.AstNode
			if (src.peek() === '}') {
				// MC-Build: End of current function block
				break
			} else if (src.peek(5) === 'block' || src.peek() === '{') {
				result = functionBlock(commandTree, options, true)(src, ctx) as MCBFunctionBlockNode
			} else if (src.peek() === '#') {
				result = comment()(src, ctx) as core.CommentNode
			} else if (src.peek() === '$') {
				result = mcf.macro(options.macros ?? false)(src, ctx) as mcf.MacroNode
			} else if (src.peek(3) === '<%%') {
				result = multilineJSBlock()(src, ctx) as MCBMultilineJSBlock
			} else {
				result = command(src, ctx) as core.AstNode
			}
			ans.children.push(result)
			src.nextLine()
		}

		ans.range.end = src.cursor
		return ans
	}
}

function functionBlockMacroArguments(): core.Parser<MCBFunctionBlockArgumentsNode> {
	return core.setType(
		'mcbuild:function_block_arguments',
		core.sequence([
			core.any([
				core.sequence([
					core.failOnEmpty(core.literal('with')),
					core.select([
						{
							prefix: 'block',
							parser: core.sequence([
								core.literal('block'),
								reportOnFail(
									core.failOnEmpty(
										vector({ dimension: 3 }),
									),
									localize('expected', 'vector'),
								),
							], argumentSeparator([])),
						},
						{
							prefix: 'entity',
							parser: core.sequence([
								core.literal('entity'),
								reportOnFail(
									entity('single', 'entities'),
									localize('expected', localize('selector')),
								),
							], argumentSeparator([])),
						},
						{
							prefix: 'storage',
							parser: core.sequence([
								core.literal('storage'),
								reportOnFail(
									core.failOnEmpty(
										core.resourceLocation({
											category: 'storage',
											usageType: 'reference',
											allowTag: false,
										}),
									),
									localize('expected', localize('resource-location')),
								),
							], argumentSeparator([])),
						},
						{
							// Show error message if no prefix is provided
							parser: core.literal('block', 'entity', 'storage'),
						},
					]),
					nbt.parser.path,
				], argumentSeparator([])),
				core.failOnEmpty(nbt.parser.compound),
			]),
			expectEOL(),
		]),
	)
}

function functionBlock(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
	allowBlockPrefix = true,
	allowArguments = true,
): core.Parser<MCBFunctionBlockNode> {
	const checkIfArgsAllowed: core.Parser<undefined> = (src, ctx) => {
		if (!allowArguments) {
			ctx.err.report(
				localize('mcbuild.parser.function_block.no_macro_arguments'),
				src,
			)
			return core.Failure
		}
		return undefined
	}

	const checkIfBlockPrefixAllowed: core.Parser<undefined> = (src, ctx) => {
		if (!allowBlockPrefix) {
			ctx.err.report(
				localize('mcbuild.parser.function_block.no_block_predix'),
				src,
			)
			return core.Failure
		}
		return undefined
	}

	return core.setType(
		'mcbuild:function_block',
		core.sequence([
			// [block [<function name>]] { ...
			optionalSequence([
				core.failOnEmpty(core.literal('block')),
				checkIfBlockPrefixAllowed,
				core.optional(
					core.failOnEmpty(
						stringWithJSBlockSupport({
							unquotable: {
								allowEmpty: false,
								allowList: BLOCK_NAME_CHARS,
							},
						}),
					),
				),
			], argumentSeparator([])),
			punctuation('{'),
			optionalSequence([
				argumentSeparator(),
				functionBlockMacroArguments(),
				// Nested in a new sequence to only run it if arguments are found.
				checkIfArgsAllowed,
			]),
			expectEOL(),
			core.sequence([
				(src, ctx) => functionContext(tree, argument, mcfunctionOptions)(src, ctx),
				core.sequence([
					// Wrapped in a sequence to disable the gap parser between these two parsers.
					punctuation('}'),
					expectEOL(),
				]),
			], syntaxGap()),
		]),
	)
}

function functionDefinition(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<MCBFunctionDefinitionNode> {
	return core.setType(
		'mcbuild:function_definition',
		core.sequence(
			[
				core.failOnEmpty(core.literal('function')),
				core.failOnEmpty(core.string({
					unquotable: {
						allowEmpty: false,
						allowList: FUNCTION_NAME_CHARS,
					},
				})),
				core.optional(
					core.failOnEmpty(
						core.resourceLocation({
							category: 'tag/function',
							usageType: 'reference',
							allowTag: false,
						}),
					),
				),
				functionBlock(tree, mcfunctionOptions, false, false),
			],
			argumentSeparator([]),
		),
	)
}

function dirDefinition(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<MCBDirectoryDefinitionNode> {
	return core.setType(
		'mcbuild:directory_definition',
		core.sequence([
			core.sequence([
				core.failOnEmpty(core.literal('dir')),
				core.failOnEmpty(core.string({
					unquotable: {
						allowEmpty: false,
						allowList: FUNCTION_NAME_CHARS,
					},
				})),
			], argumentSeparator([])),
			punctuation('{'),
			expectEOL(),
			core.repeat((src, ctx) => dirContext(tree, mcfunctionOptions)(src, ctx), syntaxGap()),
			punctuation('}'),
			expectEOL(),
		], syntaxGap()),
	)
}

function dirContext(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<MCBDirContextNode> {
	return core.any([
		functionDefinition(tree, mcfunctionOptions),
		dirDefinition(tree, mcfunctionOptions),
	])
}

export function entry(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<MCBNode> {
	return core.setType(
		'mcbuild:entry',
		core.repeat(dirContext(tree, mcfunctionOptions), syntaxGap()),
	)
}
