import * as core from '@spyglassmc/core'
import * as mcdoc from '@spyglassmc/mcdoc'
import type {
	JsonArrayNode,
	JsonNode,
	JsonObjectNode,
	JsonPrimitiveNode,
	JsonStringNode,
} from '../node/index.js'

const array: core.Completer<JsonArrayNode> = (node, ctx) => {
	const index = core.binarySearch(node.children, ctx.offset, (n, o) => {
		return core.Range.compareOffset(n.range, o, true)
	})
	const item = index >= 0 ? node.children[index] : undefined
	if (item?.value) {
		return ctx.meta.getCompleter(item.value.type)(item.value, ctx)
	}
	if (node.typeDef?.kind === 'list') {
		const completions = valuesAt(node.typeDef.item, ctx.offset, ctx, !!node.relaxed)
		if (ctx.offset < (node.children[node.children.length - 1]?.range.start ?? 0)) {
			return completions.map(c => ({ ...c, insertText: c.insertText + ',' }))
		}
		return completions
	}
	return []
}

const record = core.completer.record<JsonStringNode, JsonNode, JsonObjectNode>({
	key: (record, pair, ctx, range, iv, ipe, existingKeys) =>
		keyItems(record, ctx, pair?.key ?? range, iv, ipe, existingKeys),
	value: (record, pair, ctx, range) => {
		if (pair.value) {
			return ctx.meta.getCompleter(pair.value.type)(pair.value, ctx)
		}
		if (pair.key && record.typeDef) {
			const pairKey = pair.key.value
			const field = mcdoc.runtime.completer.getFields(record.typeDef, ctx)
				.find(({ key }) => key === pairKey)
				?.field.type
			if (field) {
				return valuesAt(field, range, ctx, !!record.relaxed)
			}
		}
		return []
	},
})

const object: core.Completer<JsonObjectNode> = (node, ctx) => {
	// JSON's parser skips an unquoted word, so no key node is there for `record` to find.
	const word = bareWordAt(ctx)
	const inChild = node.children.some(({ key, value }) =>
		[key, value].some((n) =>
			n && !core.Range.isEmpty(n.range) && core.Range.contains(n, ctx.offset, true)
		)
	)
	if (
		word && !inChild && node.innerRange && core.Range.contains(node.innerRange, ctx.offset, true)
	) {
		const before = ctx.doc.getText().slice(0, word.start).trimEnd()
		if (!before.endsWith(':')) {
			const keys = node.children.flatMap((n) => n.key ? [n.key] : [])
			const hasNextPair = node.children.some((n) => n.key && n.range.start >= word.end)
			return keyItems(node, ctx, word, true, hasNextPair, keys)
				.map((item) => ({ ...item, filterText: item.label }))
		}
	}
	return record(node, ctx)
}

function keyItems(
	record: core.DeepReadonly<JsonObjectNode>,
	ctx: core.CompleterContext,
	range: core.RangeLike,
	insertValue: boolean,
	insertPairEnd: boolean,
	existingKeys: core.DeepReadonly<JsonStringNode>[],
): core.CompletionItem[] {
	if (!record.typeDef) {
		return []
	}
	const keySet = new Set(existingKeys.map(n => n.value))
	// A key the user started with a quote stays quoted.
	const typedQuote = !!(range as Partial<core.DeepReadonly<JsonStringNode>>).quote
	return mcdoc.runtime.completer
		.getFields(record.typeDef, ctx)
		.filter(({ key }) => !keySet.has(key))
		.map(({ key, field }) => {
			const value = insertValue ? valuePlaceholder(field.type, ctx, key) : undefined
			const spelling = quoted(key, !record.relaxed || typedQuote || !BARE_KEY.test(key))
			return core.CompletionItem.create(key, range, {
				kind: core.CompletionKind.Field,
				detail: mcdoc.McdocType.toString(field.type as core.Mutable<mcdoc.McdocType>),
				documentation: field.desc,
				deprecated: field.deprecated,
				sortText: field.optional ? '$b' : '$a', // sort above hardcoded $schema
				filterText: spelling,
				insertText: `${spelling}${value === undefined ? '' : `: ${value}`}${
					insertPairEnd ? ',' : ''
				}`,
				// Offer the value straight away, but not for a number, or for an object or
				// list, where Enter should make a new line first.
				retrigger: value !== undefined && !['${1:0}', '{$1}', '[$1]'].includes(value),
				// A key's range is its whole quoted string, closing quote included.
				replacesRange: true,
			})
		})
}

/**
 * The snippet VS Code's JSON support inserts for a property's value, by type.
 * `key` is the property being inserted, for dispatchers indexed by `%key`.
 */
function valuePlaceholder(
	type: core.DeepReadonly<mcdoc.McdocType>,
	ctx: core.CompleterContext,
	key: string,
	depth = 0,
): string {
	// A small cap guards against self-referencing types.
	if (depth > 8) {
		return '$1'
	}
	const common = (types: readonly core.DeepReadonly<mcdoc.McdocType>[]) => {
		const kept = types.filter((t) =>
			mcdoc.runtime.attribute.shouldKeepAccordingToAttributeFilters(t.attributes, ctx)
		)
		const placeholders = new Set(kept.map((t) => valuePlaceholder(t, ctx, key, depth + 1)))
		return placeholders.size === 1 ? [...placeholders][0] : '$1'
	}
	switch (type.kind) {
		case 'string':
			return '"$1"'
		case 'struct':
			return '{$1}'
		case 'list':
		case 'tuple':
		case 'byte_array':
		case 'int_array':
		case 'long_array':
			return '[$1]'
		case 'byte':
		case 'short':
		case 'int':
		case 'long':
		case 'float':
		case 'double':
			return '${1:0}'
		case 'literal':
			return type.value.kind === 'string'
				? '"$1"'
				: type.value.kind === 'boolean'
				? '$1'
				: '${1:0}'
		case 'enum':
			return type.enumKind === 'string' ? '"$1"' : '${1:0}'
		case 'concrete':
		case 'template':
		case 'mapped':
			return valuePlaceholder(type.child, ctx, key, depth + 1)
		case 'reference': {
			const data = type.path
				? ctx.symbols.query(ctx.doc, 'mcdoc', type.path)
					.getData(mcdoc.binder.TypeDefSymbolData.is)
				: undefined
			return data ? valuePlaceholder(data.typeDef, ctx, key, depth + 1) : '$1'
		}
		case 'dispatcher': {
			const members = ctx.symbols.query(ctx.doc, 'mcdoc/dispatcher', type.registry)
				.symbol?.members
			const types = members
				? dispatcherIds(type.parallelIndices, key)?.flatMap((id) => {
					const data = (members[id] ?? members['%unknown'])?.data
					return mcdoc.binder.TypeDefSymbolData.is(data) ? [data.typeDef] : []
				})
				: undefined
			return types?.length ? common(types) : '$1'
		}
		case 'union':
			return common(type.members)
		default:
			return '$1'
	}
}

/**
 * The dispatcher members `indices` pick, as mcdoc stores them (no `minecraft:`).
 * Only static indices and `[[%key]]` are known before the value exists.
 */
function dispatcherIds(
	indices: core.DeepReadonly<mcdoc.ParallelIndices>,
	key: string,
): string[] | undefined {
	const ids: string[] = []
	for (const index of indices) {
		let id: string
		if (index.kind === 'static') {
			id = index.value
		} else if (
			index.accessor.length === 1 && typeof index.accessor[0] !== 'string'
			&& index.accessor[0].keyword === 'key'
		) {
			id = key
		} else {
			return undefined
		}
		if (id.startsWith('%')) {
			return undefined
		}
		ids.push(id.replace(/^minecraft:/, ''))
	}
	return ids
}

/** Values for a spot with no value node yet, replacing an unquoted word if one was typed. */
function valuesAt(
	typeDef: core.DeepReadonly<mcdoc.McdocType>,
	range: core.RangeLike,
	ctx: core.CompleterContext,
	relaxed: boolean,
): core.CompletionItem[] {
	const word = bareWordAt(ctx)
	const items = getValues(typeDef, word ?? range, ctx, !relaxed)
	return word ? items.map((item) => ({ ...item, filterText: item.label })) : items
}

/** `node`'s range, cut at the cursor when an unclosed string runs onto later lines. */
function stringRange(node: core.DeepReadonly<JsonStringNode>, ctx: core.CompleterContext) {
	const text = ctx.doc.getText().slice(node.range.start, node.range.end)
	return text.includes('\n') ? core.Range.create(node.range.start, ctx.offset) : node.range
}

/**
 * The unquoted word that ends at the cursor, if any. JSON's parser skips such a word,
 * so completions that replace it need its range.
 */
function bareWordAt(ctx: core.CompleterContext): core.Range | undefined {
	const text = ctx.doc.getText()
	const word = /(?<!["\w.:/-])[A-Za-z_][\w.:/-]*$/.exec(
		text.slice(Math.max(0, ctx.offset - 256), ctx.offset),
	)
	return word ? core.Range.create(ctx.offset - word[0].length, ctx.offset) : undefined
}

const primitive: core.Completer<JsonPrimitiveNode> = (node, ctx) => {
	const insideRange = core.Range.contains(node, ctx.offset, true)
	// Core's string completer only knows parsed values like ids; enum strings have none.
	const quote = !isRelaxed(node) || (node.type === 'json:string' && !!node.quote)
	if (node.type === 'json:string' && insideRange && node.typeDef && !node.children?.length) {
		const values = getValues(node.typeDef, stringRange(node, ctx), ctx, quote)
		if (values.length) {
			return values
		}
	}
	if (node.type === 'json:string' && insideRange) {
		// Delegate to core's string completer for the `\N{…}` named-Unicode
		// escape completion. Works whether or not the json:string has a child
		// string-parser result.
		return core.completer.string(node, ctx)
	}
	if (!node.typeDef) {
		return []
	}
	return getValues(node.typeDef, insideRange ? node : ctx.offset, ctx, quote)
}

/** Whether `node` sits in a {@link JsonObjectNode.relaxed} object or array. */
function isRelaxed(node: core.DeepReadonly<core.AstNode>): boolean {
	for (let n: core.DeepReadonly<core.AstNode> | undefined = node; n; n = n.parent) {
		if (n.type === 'json:object' || n.type === 'json:array') {
			return !!(n as core.DeepReadonly<JsonObjectNode | JsonArrayNode>).relaxed
		}
	}
	return false
}

/** mc-build's unquoted key rule; bare values also can't read as `true`, `false` or `null`. */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.+-]*$/

function quoted(text: string, quote: boolean): string {
	return quote ? `"${text}"` : text
}

/** `quote: false` leaves string values bare where mc-build allows it. */
function getValues(
	typeDef: core.DeepReadonly<mcdoc.McdocType>,
	range: core.RangeLike,
	ctx: core.CompleterContext,
	quote = true,
): core.CompletionItem[] {
	return mcdoc.runtime.completer.getValues(typeDef, ctx)
		.map((
			{ value, labelSuffix, detail, documentation, kind, completionKind, insertText, sortText },
		) => {
			const quoteIt = kind === 'string'
				&& (quote || !BARE_KEY.test(value) || ['true', 'false', 'null'].includes(value))
			return core.CompletionItem.create(value, range, {
				kind: completionKind ?? core.CompletionKind.Value,
				labelSuffix,
				detail,
				documentation,
				filterText: quoted(value, quoteIt),
				insertText: quoted(insertText ?? value, quoteIt),
				sortText,
				replacesRange: true,
			})
		})
}

export function register(meta: core.MetaRegistry): void {
	meta.registerCompleter('json:array', array)
	meta.registerCompleter('json:boolean', primitive)
	meta.registerCompleter('json:number', primitive)
	meta.registerCompleter('json:null', primitive)
	meta.registerCompleter('json:object', object)
	meta.registerCompleter('json:string', primitive)
}
