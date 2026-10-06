import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type * as mcf from '@spyglassmc/mcfunction'
import { argument } from '../mcfunction/parser/index.js'

/** Short names for Brigadier types, which aren't `minecraft:` ones. */
const BrigadierTypes: Record<string, mcf.ArgumentTreeNode> = {
	bool: { type: 'argument', parser: 'brigadier:bool' },
	double: { type: 'argument', parser: 'brigadier:double' },
	float: { type: 'argument', parser: 'brigadier:float' },
	int: { type: 'argument', parser: 'brigadier:integer' },
	integer: { type: 'argument', parser: 'brigadier:integer' },
	long: { type: 'argument', parser: 'brigadier:long' },
	string: { type: 'argument', parser: 'brigadier:string', properties: { type: 'phrase' } },
	word: { type: 'argument', parser: 'brigadier:string', properties: { type: 'word' } },
}

/** Types that take a registry: `{resource:item}`. */
const RegistryTypes = new Set([
	'resource',
	'resource_key',
	'resource_or_tag',
	'resource_or_tag_key',
	'resource_selector',
])

/** Properties the parser needs, for types that have no sensible bare form otherwise. */
const DefaultProperties: Record<string, Record<string, unknown>> = {
	entity: { amount: 'multiple', type: 'entities' },
	score_holder: { amount: 'multiple', usageType: 'reference' },
}

/**
 * The parser for a `{Type}` in a template `@param`: a Minecraft command argument type by its short
 * name (`entity`, `vec3`, `int`), or `{resource:item}` for registry-backed ones. `undefined` if
 * unknown.
 */
export function paramTypeParser(type: string): core.Parser | undefined {
	const [name, registry] = type.split(':', 2)
	let treeNode: mcf.ArgumentTreeNode
	if (BrigadierTypes[type]) {
		treeNode = BrigadierTypes[type]
	} else if (RegistryTypes.has(name) && registry) {
		treeNode = {
			type: 'argument',
			parser: `minecraft:${name}`,
			properties: { registry: core.ResourceLocation.lengthen(registry) },
		}
	} else if (registry === undefined && !RegistryTypes.has(name)) {
		treeNode = {
			type: 'argument',
			parser: `minecraft:${name}`,
			properties: DefaultProperties[name],
		} as mcf.ArgumentTreeNode
	} else {
		return undefined
	}
	try {
		return argument(treeNode, [])
	} catch {
		return undefined
	}
}

/** The first problem parsing `text` as `type`: an error message, or `undefined` if it's valid. */
export function checkParamType(
	text: string,
	parser: core.Parser,
	ctx: core.CheckerContext,
): string | undefined {
	const src = new core.Source(text)
	const parserCtx: core.ParserContext = { ...ctx, err: new core.ErrorReporter() }
	const result = parser(src, parserCtx)
	const error = parserCtx.err.errors[0]?.message
	if (result === core.Failure || error) {
		return error ?? localize('expected', localeQuote(text))
	}
	if (src.canRead()) {
		return localize('mcfunction.parser.trailing', localeQuote(src.readRemaining()))
	}
	return undefined
}
