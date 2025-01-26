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
	MCBNode,
} from '../node'

const FUNCTION_NAME_CHARS = new Set(
	'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.'.split(''),
)
const BLOCK_NAME_CHARS = new Set([...FUNCTION_NAME_CHARS, '/'])

export const comment: core.Parser<core.CommentNode> = core.comment({
	singleLinePrefixes: new Set(['#']),
})

function syntaxGap(allowComments = true): core.InfallibleParser<core.CommentNode[]> {
	return (src: core.Source, ctx: core.ParserContext): core.CommentNode[] => {
		const ans: core.CommentNode[] = []

		src.skipSpace()
		if (allowComments) {
			while (src.canRead() && src.peek() === '#') {
				const result = comment(src, ctx) as core.CommentNode
				ans.push(result)
				src.skipSpace()
			}
		}

		return ans
	}
}

function expectArgumentGap(): core.InfallibleParser<[]> {
	return (src, ctx) => {
		if (!(src.canReadInLine() && src.trySkip(' '))) {
			ctx.err.report(localize('mcfunction.parser.eoc-unexpected'), src)
		}
		return []
	}
}

function punctuation(punctuation: string): core.InfallibleParser<core.AstNode> {
	return (src, ctx) => {
		src.skipWhitespace()
		if (!src.trySkip(punctuation)) {
			ctx.err.report(
				localize('expected-got', localeQuote(punctuation), localeQuote(src.peek())),
				src,
			)
		}
		return { type: 'punctuation', range: core.Range.create(src) }
	}
}

function functionContext(
	commandTree: mcf.RootTreeNode,
	argument: mcf.ArgumentParserGetter,
	options: mcf.McfunctionOptions,
): core.Parser<MCBFunctionBlockNode> {
	return (src, ctx) => {
		const ans: MCBFunctionBlockNode = {
			type: 'mcbuild:function_block',
			range: core.Range.create(src),
			children: [],
		}

		while (src.skipWhitespace().canReadInLine()) {
			let result: core.CommentNode | mcf.CommandNode | mcf.MacroNode | MCBFunctionBlockNode
			if (src.peek() === '}') {
				// MC-Build: End of current function block
				break
			} else if (src.peek(5) === 'block' || src.peek() === '{') {
				result = functionBlock(commandTree, options, true)(src, ctx) as MCBFunctionBlockNode
			} else if (src.peek() === '#') {
				result = comment(src, ctx) as core.CommentNode
			} else if (src.peek() === '$') {
				result = mcf.macro(options.macros ?? false)(src, ctx) as mcf.MacroNode
			} else {
				result = mcf.command(commandTree, argument, options.commandOptions)(src, ctx)
			}
			ans.children.push(result)
			src.nextLine()
		}

		ans.range.end = src.cursor
		return ans
	}
}

const functionContextEntry = (
	commandTree: RootTreeNode,
	argument: mcf.ArgumentParserGetter,
	options: mcf.McfunctionOptions = {},
) => {
	const parser = functionContext(commandTree, argument, options)
	return options.lineContinuation ? core.concatOnTrailingBackslash(parser) : parser
}

function functionBlockMacroArguments(): core.Parser<MCBFunctionBlockArgumentsNode> {
	return core.setType(
		'mcbuild:function_block_arguments',
		core.any([
			core.sequence([
				core.failOnEmpty(core.literal('with')),
				core.select([
					{
						prefix: 'block',
						parser: core.sequence([
							core.literal('block'),
							vector({ dimension: 3 }),
						], expectArgumentGap()),
					},
					{
						prefix: 'entity',
						parser: core.sequence([
							core.literal('entity'),
							(src, ctx) => {
								const res = entity('single', 'entities')(src, ctx) as EntityNode
								if (res.range.start === res.range.end) {
									ctx.err.report(localize('expected', '<target: entity>'), src)
								}
								return res
							},
						], expectArgumentGap()),
					},
					{
						prefix: 'storage',
						parser: core.sequence([
							core.literal('storage'),
							core.resourceLocation({
								category: 'storage',
								usageType: 'reference',
								allowTag: false,
							}),
						], expectArgumentGap()),
					},
					{
						// Show error message if no prefix is provided
						parser: core.literal('block', 'entity', 'storage'),
					},
				]),
				nbt.parser.path,
			], expectArgumentGap()),
			core.failOnEmpty(nbt.parser.compound),
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
				core.optional(
					core.sequence([
						core.failOnEmpty(
							core.literal('block'),
						),
						core.optional(
							core.failOnEmpty(core.string({
								unquotable: {
									allowEmpty: false,
									allowList: BLOCK_NAME_CHARS,
								},
							})),
						),
					], syntaxGap()),
				),
				punctuation('{'),
				core.optional(functionBlockMacroArguments()),
				(src, ctx) => functionContextEntry(tree, argument, mcfunctionOptions)(src, ctx),
				punctuation('}'),
			], syntaxGap()),
		)
	}

	return core.setType(
		'mcbuild:function_block',
		core.sequence([
			punctuation('{'),
			(src, ctx) => functionContextEntry(tree, argument, mcfunctionOptions)(src, ctx),
			punctuation('}'),
		], syntaxGap(false)),
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
			core.failOnEmpty(core.string({
				unquotable: {
					allowEmpty: false,
					allowList: FUNCTION_NAME_CHARS,
				},
			})),
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
		], syntaxGap(false)),
	)
}

function dirDefinition(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<MCBDirectoryDefinitionNode> {
	return core.setType(
		'mcbuild:directory_definition',
		core.sequence([
			core.failOnEmpty(core.literal('dir')),
			core.failOnEmpty(core.string({
				unquotable: {
					allowEmpty: false,
					allowList: FUNCTION_NAME_CHARS,
				},
			})),
			punctuation('{'),
			core.repeat((src, ctx) => dirContext(tree, mcfunctionOptions)(src, ctx), syntaxGap()),
			punctuation('}'),
		], syntaxGap(false)),
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
