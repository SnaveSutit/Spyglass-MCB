import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { RootTreeNode } from '@spyglassmc/mcfunction'
import * as mcf from '@spyglassmc/mcfunction'
import { argument } from '../../mcfunction/parser'
import type {
	McbuildFunctionBlockNode,
	McbuildFunctionDefinitionNode,
	McbuildNode,
	TopLevelNode,
} from '../node'

const FUNCTION_NAME_CHARS = new Set(
	'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.'.split(''),
)

function parseFunctionBlock(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<McbuildFunctionBlockNode> {
	return (src, ctx) => {
		if (core.failOnEmpty(core.literal('{'))(src, ctx) === core.Failure) {
			return core.Failure
		}
		src.skipWhitespace()
		const contentSrc = src.clone()
		const contentStart = src.cursor

		while (src.canRead()) {
			src.nextLine()
			src.skipWhitespace()
			if (src.tryPeek('}')) {
				break
			}
		}
		contentSrc.string = contentSrc.string.slice(0, src.cursor)
		if (!src.trySkip('}')) {
			ctx.err.report(localize('expected', localeQuote('}')), src)
		}

		const content = mcf.entry(tree, argument, mcfunctionOptions)(contentSrc, ctx)
		if (content === core.Failure) {
			return core.Failure
		}

		return {
			type: 'mcbuild:function_block',
			range: core.Range.create(contentStart, src),
			children: [content],
		}
	}
}

function functionDefinition(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<McbuildFunctionDefinitionNode> {
	return (src, ctx) => {
		const start = src.cursor
		const literal = core.failOnEmpty(core.literal('function'))(src, ctx)
		if (literal === core.Failure) {
			return core.Failure
		}

		src.skipWhitespace()
		const name = core.string({
			unquotable: {
				allowEmpty: false,
				allowList: FUNCTION_NAME_CHARS,
			},
		})(src, ctx)
		src.skipWhitespace()

		const block = parseFunctionBlock(tree, mcfunctionOptions)(src, ctx)
		if (block === core.Failure) {
			return core.Failure
		}

		return {
			type: 'mcbuild:function_definition',
			range: core.Range.create(start, src),
			children: [literal, name, block],
		}
	}
}

function topLevel(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<TopLevelNode> {
	return core.any([
		functionDefinition(tree, mcfunctionOptions),
	])
}

export function entry(
	tree: RootTreeNode,
	mcfunctionOptions: mcf.McfunctionOptions,
): core.Parser<McbuildNode> {
	return core.setType(
		'mcbuild:entry',
		core.repeat(topLevel(tree, mcfunctionOptions)),
	)
}
