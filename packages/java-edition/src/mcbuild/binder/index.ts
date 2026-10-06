import * as core from '@spyglassmc/core'
import type { DocComment } from '../doc.js'
import { docCommentAbove, renderDocComment } from '../doc.js'
import type { EntryNode, TemplateArgKind } from '../node/index.js'
import {
	ClockDefinitionNode,
	DirectoryDefinitionNode,
	FunctionDefinitionNode,
	JsonFileNode,
	ReferenceNode,
	TemplateDefinitionNode,
	TemplateOverloadNode,
} from '../node/index.js'

export const TEMPLATE_CATEGORY = 'mcbuild/template'
/**
 * `function` / `clock` definitions in files outside a `src/` root, keyed by their `dir` path.
 * Under `src/` they resolve to real ids, so they use the vanilla {@link VANILLA_FUNCTION_CATEGORY}
 * and link with `.mcfunction` files.
 */
export const FUNCTION_CATEGORY = 'mcbuild/function'
export const VANILLA_FUNCTION_CATEGORY = 'function'
export const FUNCTION_TAG_CATEGORY = 'tag/function'

export interface TemplateParamData {
	/** Param name, or the text of a `literal` param. */
	name: string
	kind: TemplateArgKind
}

export interface TemplateOverloadData {
	params: TemplateParamData[]
	/** The `#>` block above this `with`. */
	doc?: DocComment
}

/** `a:int mode b:block`, as written in a `with` line. */
export function describeParams(params: readonly TemplateParamData[]): string {
	return params.map((p) => (p.kind === 'literal' ? p.name : `${p.name}:${p.kind}`)).join(' ')
}

export interface TemplateSymbolData {
	overloads: TemplateOverloadData[]
	doc?: DocComment
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
	for (const [i, child] of children.entries()) {
		if (TemplateDefinitionNode.is(child)) {
			bindTemplate(child, ctx, docCommentAbove(children, i, ctx.doc.getText()))
		} else if (FunctionDefinitionNode.is(child) || ClockDefinitionNode.is(child)) {
			const doc = docCommentAbove(children, i, ctx.doc.getText())
			bindFunction(child, ctx, dirStack, base, doc)
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
	doc: DocComment | undefined,
) {
	if (node.id.value.length === 0) {
		return
	}
	const key = base
		? `${base.namespace}:${[...base.path, ...dirStack, node.id.value].join('/')}`
		: [...dirStack, node.id.value].join('/')
	ctx.symbols.query(ctx.doc, base ? VANILLA_FUNCTION_CATEGORY : FUNCTION_CATEGORY, key).enter({
		// Always set, so removing a doc block clears it.
		data: { desc: doc && renderDocComment(doc), data: doc && { doc } },
		usage: { type: 'definition', node: node.id, fullRange: node.range },
	})
	if (FunctionDefinitionNode.is(node) && node.appendTo) {
		// mc-build creates the tag if needed, so appending defines it.
		const tag = core.ResourceLocationNode.toString(node.appendTo, 'full')
		ctx.symbols.query(ctx.doc, FUNCTION_TAG_CATEGORY, tag).enter({
			usage: { type: 'definition', node: node.appendTo },
		})
	}
	if (base && node.body) {
		bindCallReferences(node.body, ctx, dirStack, base, [key])
	}
}

/** Statements mc-build compiles to a generated function, which `^N` counts as a frame. */
const GeneratedFrameTypes = new Set([
	'mcbuild:execute_block',
	'mcbuild:schedule_block',
	'mcbuild:load_block',
	'mcbuild:tick_block',
])

/**
 * Records each call in `root` as a reference to its target. `frames` mirrors mc-build's
 * function stack for `^N`: named function ids, or `undefined` for generated ones.
 */
function bindCallReferences(
	root: core.AstNode,
	ctx: core.BinderContext,
	dirStack: readonly string[],
	base: FileBase,
	frames: readonly (string | undefined)[],
) {
	const visit = (n: core.AstNode, frames: readonly (string | undefined)[]) => {
		const target = callTarget(n)
		if (target) {
			enterReference(target, ctx, dirStack, base, frames)
		}
		const inner = GeneratedFrameTypes.has(n.type) ? [...frames, undefined] : frames
		for (const c of n.children ?? []) {
			visit(c, inner)
		}
	}
	visit(root, frames)
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
	frames: readonly (string | undefined)[],
) {
	if (/<%|\$\(/.test(ref.path)) {
		// Only known at build time.
		return
	}
	const id = ref.scheme === 'parent'
		? frames[frames.length - 1 - (ref.depth ?? 0)]
		: resolveFunctionId(ref, base, dirStack)
	if (!id) {
		return
	}
	ref.resolved = id
	const category = ref.isTag ? FUNCTION_TAG_CATEGORY : VANILLA_FUNCTION_CATEGORY
	ctx.symbols.query(ctx.doc, category, id).enter({
		usage: { type: 'reference', node: ref },
	})
}

/** Defines a `tag function` as `namespace:path/name`, like mc-build, and links its entries. */
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
	if (/^[^\s:<$]+$/.test(node.id.value)) {
		const id = `${base.namespace}:${[...base.path, ...dirStack, node.id.value].join('/')}`
		ctx.symbols.query(ctx.doc, FUNCTION_TAG_CATEGORY, id).enter({
			usage: { type: 'definition', node: node.id, fullRange: node.range },
		})
	}
	for (const tagEntry of node.entries) {
		const value = (tagEntry as { value?: core.AstNode }).value
		if (ReferenceNode.is(value)) {
			enterReference(value, ctx, dirStack, base, [])
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

function bindTemplate(
	node: TemplateDefinitionNode,
	ctx: core.BinderContext,
	doc: DocComment | undefined,
) {
	if (node.id.value.length === 0) {
		return
	}
	const overloads: TemplateOverloadData[] = []
	for (const [i, child] of node.children.entries()) {
		if (TemplateOverloadNode.is(child)) {
			const doc = docCommentAbove(node.children, i, ctx.doc.getText())
			overloads.push({
				params: child.params.map((p) => ({ name: p.name.value, kind: p.kind })),
				...(doc ? { doc } : {}),
			})
		}
	}
	ctx.symbols.query(ctx.doc, TEMPLATE_CATEGORY, node.id.value).enter({
		data: {
			desc: templateDesc(node.id.value, overloads, doc),
			data: { overloads, doc } satisfies TemplateSymbolData,
		},
		usage: {
			type: 'definition',
			node: node.id,
			fullRange: node.range,
		},
	})
}

/** Hover markdown: every overload as a call, then the doc block. */
function templateDesc(
	name: string,
	overloads: readonly TemplateOverloadData[],
	doc: DocComment | undefined,
): string {
	const calls = overloads.map((o) => `${name} ${describeParams(o.params)}`.trimEnd())
	const parts = [`\`\`\`mc-build\n${calls.join('\n')}\n\`\`\``]
	if (doc) {
		parts.push(renderDocComment(doc))
	}
	return parts.join('\n\n')
}

export function register(meta: core.MetaRegistry): void {
	meta.registerBinder<EntryNode>('mcbuild:entry', entry)
}
