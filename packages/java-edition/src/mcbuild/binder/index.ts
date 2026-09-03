import type * as core from '@spyglassmc/core'
import type { EntryNode, TemplateArgKind } from '../node/index.js'
import {
	DirectoryDefinitionNode,
	FunctionDefinitionNode,
	TemplateDefinitionNode,
} from '../node/index.js'

export const TEMPLATE_CATEGORY = 'mcbuild/template'
/** The `mcbuild/function` symbol category holds `dir`-scoped `function <name>` paths. */
export const FUNCTION_CATEGORY = 'mcbuild/function'

export interface TemplateParamData {
	/** Param name, or the text of a `literal` param. */
	name: string
	kind: TemplateArgKind
}

export interface TemplateOverloadData {
	params: TemplateParamData[]
}

export interface TemplateSymbolData {
	overloads: TemplateOverloadData[]
}

export function getTemplateData(symbol: core.Symbol | undefined): TemplateSymbolData | undefined {
	const data = symbol?.data as { data?: unknown } | undefined
	const inner = (data?.data ?? symbol?.data) as { overloads?: unknown } | undefined
	return Array.isArray(inner?.overloads) ? (inner as TemplateSymbolData) : undefined
}

const entry: core.SyncBinder<EntryNode> = (node, ctx) => {
	bindChildren(node.children, ctx, [])
}

function bindChildren(
	children: readonly core.AstNode[],
	ctx: core.BinderContext,
	dirStack: string[],
) {
	for (const child of children) {
		if (TemplateDefinitionNode.is(child)) {
			bindTemplate(child, ctx)
		} else if (FunctionDefinitionNode.is(child)) {
			const path = [...dirStack, child.id.value].join('/')
			if (child.id.value.length > 0) {
				ctx.symbols.query(ctx.doc, FUNCTION_CATEGORY, path).enter({
					usage: {
						type: 'definition',
						node: child.id,
						fullRange: child.range,
					},
				})
			}
		} else if (DirectoryDefinitionNode.is(child)) {
			const body = child.body
			if (body) {
				bindChildren(body.children, ctx, [...dirStack, child.id.value])
			}
		}
	}
}

function bindTemplate(node: TemplateDefinitionNode, ctx: core.BinderContext) {
	if (node.id.value.length === 0) {
		return
	}
	const overloads: TemplateOverloadData[] = node.overloads.map((overload) => ({
		params: overload.params.map((p) => ({ name: p.name.value, kind: p.kind })),
	}))
	ctx.symbols.query(ctx.doc, TEMPLATE_CATEGORY, node.id.value).enter({
		data: { data: { overloads } satisfies TemplateSymbolData },
		usage: {
			type: 'definition',
			node: node.id,
			fullRange: node.range,
		},
	})
}

export function register(meta: core.MetaRegistry): void {
	meta.registerBinder<EntryNode>('mcbuild:entry', entry)
}
