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
