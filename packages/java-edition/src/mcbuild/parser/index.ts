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

const skipUntil: core.Parser<undefined> = (src, ctx) => {
	src.readUntil('<%', core.LF, core.CR)
	if (!src.canReadInLine()) {
		ctx.err.report(localize('expected', '<%'), src)
		return core.Failure
	}
	return undefined
}

function comment(): core.Parser<core.CommentNode> {
	return (src, ctx) => {
		const res = core.comment({
			singleLinePrefixes: new Set(['#']),
		})(src, ctx) as core.CommentNode
		if (res.comment.match(LINE_CONTAINS_INLINE_JS_BLOCK)) {
			const commentSrc = new core.Source(res.comment)
			const blocks = core.repeat(
				core.failOnEmpty(
					core.sequence([
						skipUntil,
						inlineJSBlock(),
					]),
				),
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

const argumentSeparator = core.map(mcf.sep, () => undefined)

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

function punctuation(punctuation: string): core.InfallibleParser<undefined> {
	return (src, ctx) => {
		src.skipWhitespace()
		if (!src.trySkip(punctuation)) {
			ctx.err.report(
				localize(
					'expected-got',
					localeQuote(punctuation),
					localeQuote(src.peek(punctuation.length)),
				),
				src,
			)
		}
	}
}

function inlineJSBlock(): core.InfallibleParser<MCBInlineJSBlock> {
	return core.setType(
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
}

function stringWithjsBlockSupport(
	options: Required<Pick<core.StringOptions, 'unquotable'>>,
): core.InfallibleParser<MCBStringWithInlineJSBlock> {
	return core.setType(
		'mcbuild:string_with_inline_js_block',
		core.repeat(
			core.failOnEmpty(
				core.any([
					core.failOnEmpty(
						core.stopBefore(
							core.string(options),
							'<%',
							core.LF,
							core.CR,
						),
					),
					core.failOnError(inlineJSBlock()),
				]),
			),
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
		stringWithjsBlockSupport({
			unquotable: {
				allowEmpty: true,
				blockList: new Set(),
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
					argumentSeparator,
					core.select([
						{
							prefix: 'block',
							parser: core.sequence([
								core.literal('block'),
								argumentSeparator,
								vector({ dimension: 3 }),
							]),
						},
						{
							prefix: 'entity',
							parser: core.sequence([
								core.literal('entity'),
								argumentSeparator,
								(src, ctx) => {
									const res = entity('single', 'entities')(src, ctx) as EntityNode
									if (res.range.start === res.range.end) {
										ctx.err.report(localize('expected', '<target: entity>'), src)
									}
									return res
								},
							]),
						},
						{
							prefix: 'storage',
							parser: core.sequence([
								core.literal('storage'),
								argumentSeparator,
								core.resourceLocation({
									category: 'storage',
									usageType: 'reference',
									allowTag: false,
								}),
							]),
						},
						{
							// Show error message if no prefix is provided
							parser: core.literal('block', 'entity', 'storage'),
						},
					]),
					argumentSeparator,
					nbt.parser.path,
				]),
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
): core.Parser<MCBFunctionBlockNode> {
	if (allowBlockPrefix) {
		return core.setType(
			'mcbuild:function_block',
			core.sequence([
				optionalSequence([
					core.failOnEmpty(
						core.literal('block'),
					),
					argumentSeparator,
					optionalSequence([
						core.failOnEmpty(
							stringWithjsBlockSupport({
								unquotable: {
									allowEmpty: false,
									allowList: BLOCK_NAME_CHARS,
								},
							}),
						),
						argumentSeparator,
					]),
				]),
				punctuation('{'),
				optionalSequence([
					argumentSeparator,
					functionBlockMacroArguments(),
				]),
				core.sequence([
					(src, ctx) => functionContext(tree, argument, mcfunctionOptions)(src, ctx),
					punctuation('}'),
				], syntaxGap()),
			]),
		)
	}

	return core.setType(
		'mcbuild:function_block',
		core.sequence([
			punctuation('{'),
			(src, ctx) => functionContext(tree, argument, mcfunctionOptions)(src, ctx),
			punctuation('}'),
		], syntaxGap()),
	)
}

function functionDefinition(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<MCBFunctionDefinitionNode> {
	return core.setType(
		'mcbuild:function_definition',
		core.sequence([
			core.failOnEmpty(core.literal('function')),
			argumentSeparator,
			core.failOnEmpty(core.string({
				unquotable: {
					allowEmpty: false,
					allowList: FUNCTION_NAME_CHARS,
				},
			})),
			argumentSeparator,
			core.optional(
				core.failOnEmpty(
					core.resourceLocation({
						category: 'function',
						usageType: 'reference',
						allowTag: false,
					}),
				),
			),
			functionBlock(tree, mcfunctionOptions, false),
		]),
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
				argumentSeparator,
				core.failOnEmpty(core.string({
					unquotable: {
						allowEmpty: false,
						allowList: FUNCTION_NAME_CHARS,
					},
				})),
			]),
			punctuation('{'),
			core.repeat((src, ctx) => dirContext(tree, mcfunctionOptions)(src, ctx), syntaxGap()),
			punctuation('}'),
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
