import type * as core from '@spyglassmc/core'
import type { EntryNode, TemplateArgKind } from '../node/index.js'
import {
	ClockDefinitionNode,
	DirectoryDefinitionNode,
	FunctionDefinitionNode,
	JsonFileNode,
	ReferenceNode,
	TemplateDefinitionNode,
} from '../node/index.js'

export const TEMPLATE_CATEGORY = 'mcbuild/template'
/**
 * `function` / `clock` definitions, keyed by `namespace:path` under a `src/`
 * root (else the `dir` path). Calls are recorded as references to the same key.
 */
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
	const data = symbol?.data as Partial<TemplateSymbolData> | undefined
	return Array.isArray(data?.overloads) ? (data as TemplateSymbolData) : undefined
}

export interface FileBase {
	namespace: string
	/** Segments after the namespace, ending with the file name. */
	path: string[]
}

/**
 * A file's namespace and base path, assuming a `src/` root:
 * `src/foo/bar.mcb` -> `{ namespace: 'foo', path: ['bar'] }`.
 */
export function fileBase(uri: string): FileBase | undefined {
	let decoded = uri
	try {
		decoded = decodeURIComponent(uri)
	} catch {
	}
	const idx = decoded.lastIndexOf('/src/')
	if (idx < 0) {
		return undefined
	}
	const rel = decoded.slice(idx + '/src/'.length).replace(/\.mcbt?$/, '')
	const parts = rel.split('/').filter((s) => s.length > 0)
	const namespace = parts.shift()
	if (!namespace) {
		return undefined
	}
	return { namespace, path: parts }
}

/**
 * Port of mc-build's `evaluateFunctionHandle`. `undefined` for `^N` (generated
 * functions) and paths that climb above the namespace.
 */
export function resolveFunctionId(
	ref: ReferenceNode,
	base: FileBase,
	dirStack: readonly string[],
): string | undefined {
	switch (ref.scheme) {
		case 'parent':
			return undefined
		case 'id':
			return /^[^:]+:.+/.test(ref.path) ? ref.path : undefined
		case 'absolute':
			return ref.path.length > 0 ? `${base.namespace}:${ref.path}` : undefined
		case 'relative': {
			const anchor = [...base.path, ...dirStack]
			const resolved: string[] = [...anchor]
			for (const segment of ref.path.split('/')) {
				if (segment === '..') {
					if (resolved.length === 0) {
						return undefined
					}
					resolved.pop()
				} else if (segment !== '.' && segment !== '') {
					resolved.push(segment)
				}
			}
			return resolved.length > 0 ? `${base.namespace}:${resolved.join('/')}` : undefined
		}
		default:
			return undefined
	}
}

const entry: core.SyncBinder<EntryNode> = (node, ctx) => {
	bindChildren(node.children, ctx, [], fileBase(ctx.doc.uri))
}

function bindChildren(
	children: readonly core.AstNode[],
	ctx: core.BinderContext,
	dirStack: string[],
	base: FileBase | undefined,
) {
	for (const child of children) {
		if (TemplateDefinitionNode.is(child)) {
			bindTemplate(child, ctx)
		} else if (FunctionDefinitionNode.is(child) || ClockDefinitionNode.is(child)) {
			bindFunction(child, ctx, dirStack, base)
		} else if (DirectoryDefinitionNode.is(child)) {
			if (child.body) {
				bindChildren(child.body.children, ctx, [...dirStack, child.id.value], base)
			}
		} else if (JsonFileNode.is(child)) {
			bindFunctionTag(child, ctx, dirStack, base)
		} else if (isCompileTimeBlock(child)) {
			// Top-level `IF` / `REPEAT` bodies can define functions too.
			for (const body of compileTimeBodies(child)) {
				bindChildren(body.children ?? [], ctx, dirStack, base)
			}
		}
	}
}

/** mc-build compiles a `clock` to a function, same as `function`. */
function bindFunction(
	node: FunctionDefinitionNode | ClockDefinitionNode,
	ctx: core.BinderContext,
	dirStack: string[],
	base: FileBase | undefined,
) {
	if (node.id.value.length === 0) {
		return
	}
	const key = base
		? `${base.namespace}:${[...base.path, ...dirStack, node.id.value].join('/')}`
		: [...dirStack, node.id.value].join('/')
	ctx.symbols.query(ctx.doc, FUNCTION_CATEGORY, key).enter({
		usage: { type: 'definition', node: node.id, fullRange: node.range },
	})
	if (base && node.body) {
		bindCallReferences(node.body, ctx, dirStack, base)
	}
}

/** Records each call in `root` as a reference to its target. */
function bindCallReferences(
	root: core.AstNode,
	ctx: core.BinderContext,
	dirStack: readonly string[],
	base: FileBase,
) {
	const visit = (n: core.AstNode) => {
		const target = callTarget(n)
		if (target) {
			enterReference(target, ctx, dirStack, base)
		}
		for (const c of n.children ?? []) {
			visit(c)
		}
	}
	visit(root)
}

function callTarget(node: core.AstNode): ReferenceNode | undefined {
	if (
		node.type === 'mcbuild:function_call'
		|| node.type === 'mcbuild:schedule_call'
		|| node.type === 'mcbuild:schedule_clear'
	) {
		const target = (node as { target?: core.AstNode }).target
		return ReferenceNode.is(target) ? target : undefined
	}
	return undefined
}

function enterReference(
	ref: ReferenceNode,
	ctx: core.BinderContext,
	dirStack: readonly string[],
	base: FileBase,
) {
	if (ref.isTag) {
		// Function tags aren't indexed yet.
		return
	}
	const id = resolveFunctionId(ref, base, dirStack)
	if (!id) {
		return
	}
	ref.resolved = id
	ctx.symbols.query(ctx.doc, FUNCTION_CATEGORY, id).enter({
		usage: { type: 'reference', node: ref },
	})
}

/** Links `tag function` entries to their functions. */
function bindFunctionTag(
	node: JsonFileNode,
	ctx: core.BinderContext,
	dirStack: string[],
	base: FileBase | undefined,
) {
	if (!base || node.kind !== 'tag') {
		return
	}
	const registry = node.registry?.value
	if (registry !== 'function' && registry !== 'functions') {
		return
	}
	for (const tagEntry of node.entries) {
		const value = (tagEntry as { value?: core.AstNode }).value
		if (ReferenceNode.is(value)) {
			enterReference(value, ctx, dirStack, base)
		}
	}
}

function isCompileTimeBlock(node: core.AstNode): boolean {
	return node.type === 'mcbuild:compiletime_if' || node.type === 'mcbuild:compiletime_loop'
}

function compileTimeBodies(node: core.AstNode): core.AstNode[] {
	const bodies: core.AstNode[] = []
	const self = node as {
		body?: core.AstNode
		elifs?: { body?: core.AstNode }[]
	}
	if (self.body) {
		bodies.push(self.body)
	}
	for (const elif of self.elifs ?? []) {
		if (elif.body) {
			bodies.push(elif.body)
		}
	}
	return bodies
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
