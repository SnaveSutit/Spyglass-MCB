import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type * as acorn from 'acorn'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import { compoundKeys } from './checker/index.js'
import type { CompileTimeLoopNode, IdentifierNode } from './node/index.js'
import {
	FunctionCallNode,
	FunctionDefinitionNode,
	JsNode,
	TemplateOverloadNode,
} from './node/index.js'
import { jsAst } from './parser/js.js'

type Node = core.DeepReadonly<core.AstNode>

/**
 * Renames names scoped to one owner: template `with` params, `REPEAT … as` variables, and macro
 * arguments (`$(x)`, `@arg x`, and `{x:…}` keys at call sites).
 */
export function localTarget(
	file: Node,
	ctx: core.RenameProviderContext,
): core.RenameTarget | undefined {
	const path = pathTo(file, ctx.offset)
	return scriptVariableTarget(path, ctx) ?? macroArgTarget(path, ctx)
}

// #region template params and loop variables

function scriptVariableTarget(
	path: readonly Node[],
	ctx: core.RenameProviderContext,
): core.RenameTarget | undefined {
	const deepest = path[path.length - 1]
	let name: string | undefined
	let range: core.Range | undefined
	let from: readonly Node[] = path
	if (JsNode.is(deepest as core.AstNode)) {
		const id = identifierAt(deepest as JsNode, ctx.offset)
		if (!id) {
			return undefined
		}
		;({ name, range } = id)
	} else if (deepest?.type === 'mcbuild:identifier' && isDeclaration(deepest, path)) {
		name = (deepest as IdentifierNode).value
		range = deepest.range
	} else {
		const tag = docTagAt(ctx.doc.getText(), ctx.offset, 'param')
		const overload = tag && overloadDocumentedAt(path, ctx)
		if (!tag || !overload) {
			return undefined
		}
		;({ name, range } = tag)
		from = [...pathTo(path[0], overload.range.start + 1)]
	}
	const scope = declaringScope(from, name, range)
	if (!scope) {
		return undefined
	}
	return {
		range,
		placeholder: name,
		rename: async (newName) => {
			if (!/^[A-Za-z_][\w]*$/.test(newName)) {
				return localize('mcbuild.rename.invalid-variable', localeQuote(newName))
			}
			const text = ctx.doc.getText()
			const ranges = [scope.declaration.range, ...scriptUses(scope.body, name)]
			if (TemplateOverloadNode.is(scope.owner as core.AstNode)) {
				ranges.push(
					...docTagRanges(text, docLinesAbove(text, scope.owner.range.start), 'param', name),
				)
			}
			return [{ doc: ctx.doc, edits: dedupe(ranges).map((r) => ({ range: r, text: newName })) }]
		},
	}
}

interface Scope {
	owner: Node
	declaration: Node
	body: Node | undefined
}

/** The innermost loop or overload around `path` that declares `name`. */
function declaringScope(path: readonly Node[], name: string, at: core.Range): Scope | undefined {
	for (let i = path.length - 1; i >= 0; i--) {
		const node = path[i]
		if (node.type === 'mcbuild:compiletime_loop') {
			const loop = node as core.DeepReadonly<CompileTimeLoopNode>
			// A loop's own expression is evaluated outside it.
			const inExpression = core.Range.containsRange(loop.expression.range, at, true)
			const declaration = loop.vars.find((v) => v.value === name)
			if (declaration && !inExpression) {
				return { owner: loop, declaration, body: loop.body }
			}
		} else if (TemplateOverloadNode.is(node as core.AstNode)) {
			const overload = node as core.DeepReadonly<TemplateOverloadNode>
			const declaration = overload.params.find((p) =>
				p.kind !== 'literal' && p.name.value === name
			)
			if (declaration) {
				return { owner: overload, declaration: declaration.name, body: overload.body }
			}
		}
	}
	return undefined
}

/** Whether an identifier node declares a loop variable or a template param. */
function isDeclaration(id: Node, path: readonly Node[]): boolean {
	const parent = path[path.length - 2]
	return parent?.type === 'mcbuild:compiletime_loop'
		|| (parent?.type === 'mcbuild:template_arg'
			&& (parent as { kind?: string }).kind !== 'literal'
			&& (parent as { name?: Node }).name?.range.start === id.range.start)
}

/** Every script identifier named `name` under `body`, skipping loops that redeclare it. */
function scriptUses(body: Node | undefined, name: string): core.Range[] {
	const ranges: core.Range[] = []
	const visit = (node: Node) => {
		if (JsNode.is(node as core.AstNode)) {
			ranges.push(...identifiersNamed(node as JsNode, name))
			return
		}
		if (node.type === 'mcbuild:compiletime_loop') {
			const loop = node as core.DeepReadonly<CompileTimeLoopNode>
			visit(loop.expression)
			if (loop.vars.some((v) => v.value === name)) {
				return
			}
		}
		for (const child of node.children ?? []) {
			visit(child)
		}
	}
	if (body) {
		visit(body)
	}
	return ranges
}

/** The script identifier at `offset`, if it's a variable rather than a property name. */
function identifierAt(js: JsNode, offset: number): { name: string; range: core.Range } | undefined {
	const ast = jsAst(js)
	if (!ast) {
		return undefined
	}
	for (const [id, range] of variableIdentifiers(js, ast)) {
		if (core.Range.contains(range, offset, true)) {
			return { name: id.name, range }
		}
	}
	return undefined
}

function identifiersNamed(js: JsNode, name: string): core.Range[] {
	const ast = jsAst(js)
	return ast
		? [...variableIdentifiers(js, ast)].filter(([id]) => id.name === name).map(([, r]) => r)
		: []
}

/** Identifiers that name variables, with their document ranges: not `a.prop` or `{ prop: … }`. */
function* variableIdentifiers(
	js: JsNode,
	ast: acorn.Node,
): Generator<[acorn.Identifier, core.Range]> {
	const properties = new Set<acorn.Node>()
	const identifiers: acorn.Identifier[] = []
	const visit = (node: acorn.Node) => {
		if (node.type === 'Identifier') {
			identifiers.push(node as acorn.Identifier)
		} else if (node.type === 'MemberExpression' && !(node as acorn.MemberExpression).computed) {
			properties.add((node as acorn.MemberExpression).property)
		} else if (node.type === 'Property') {
			const prop = node as acorn.Property
			if (!prop.computed && !prop.shorthand) {
				properties.add(prop.key)
			}
		}
		for (const value of Object.values(node)) {
			for (const child of Array.isArray(value) ? value : [value]) {
				if (typeof (child as acorn.Node | undefined)?.type === 'string') {
					visit(child as acorn.Node)
				}
			}
		}
	}
	visit(ast)
	const seen = new Set<number>()
	for (const id of identifiers) {
		if (!properties.has(id) && !seen.has(id.start)) {
			seen.add(id.start)
			yield [id, core.Range.create(js.range.start + id.start, js.range.start + id.end)]
		}
	}
}

/** The template overload whose `#>` block contains `offset`. */
function overloadDocumentedAt(
	path: readonly Node[],
	ctx: core.RenameProviderContext,
): Node | undefined {
	const template = [...path].reverse().find((n) => n.type === 'mcbuild:template_definition')
	const text = ctx.doc.getText()
	return template?.children?.find((c) =>
		TemplateOverloadNode.is(c as core.AstNode)
		&& docLinesAbove(text, c.range.start).some((l) => core.Range.contains(l, ctx.offset, true))
	)
}

// #endregion
// #region macro arguments

function macroArgTarget(
	path: readonly Node[],
	ctx: core.RenameProviderContext,
): core.RenameTarget | undefined {
	const text = ctx.doc.getText()
	const found = macroUseAt(path, text, ctx.offset)
		?? callKeyAt(path, text, ctx.offset)
		?? argDocAt(path, text, ctx.offset)
	if (!found) {
		return undefined
	}
	const { name, range, fn } = found
	return {
		range,
		placeholder: name,
		rename: async (newName) => {
			if (!/^\w+$/.test(newName)) {
				return localize('mcbuild.rename.invalid-variable', localeQuote(newName))
			}
			const edits = new Map<string, { doc: TextDocument; ranges: core.Range[] }>()
			const add = (doc: TextDocument, ranges: core.Range[]) => {
				const entry = edits.get(doc.uri) ?? { doc, ranges: [] }
				entry.ranges.push(...ranges)
				edits.set(doc.uri, entry)
			}
			for (const type of core.SymbolUsageTypes) {
				for (const location of fn[type] ?? []) {
					if (ctx.isGenerated(location.uri) || !location.range) {
						continue
					}
					const doc = await ctx.getDocument(location.uri)
					if (!doc) {
						continue
					}
					const docText = doc.getText()
					if (type === 'definition' && location.fullRange) {
						add(doc, [
							...macroUses(docText, location.fullRange, name),
							...docTagRanges(
								docText,
								docLinesAbove(docText, location.fullRange.start),
								'arg',
								name,
							),
						])
					} else if (type === 'reference') {
						add(doc, callKeyRanges(docText, location.range.end, name))
					}
				}
			}
			return [...edits.values()].map(({ doc, ranges }) => ({
				doc,
				edits: dedupe(ranges).map((r) => ({ range: r, text: newName })),
			}))
		},
	}
}

interface MacroArg {
	name: string
	range: core.Range
	/** The function the argument belongs to. */
	fn: core.Symbol
}

/** `$(x)` at the cursor, inside a function body. */
function macroUseAt(path: readonly Node[], text: string, offset: number): MacroArg | undefined {
	const def = [...path].reverse().find((n) => FunctionDefinitionNode.is(n as core.AstNode)) as
		| core.DeepReadonly<FunctionDefinitionNode>
		| undefined
	const fn = def?.id.symbol as core.Symbol | undefined
	if (!def || !fn) {
		return undefined
	}
	const use = macroUses(text, def.range).find((r) => core.Range.contains(r, offset, true))
	return use && { name: text.slice(use.start, use.end), range: use, fn }
}

/** A `{x: …}` key at the cursor, in a function call's macro data. */
function callKeyAt(path: readonly Node[], text: string, offset: number): MacroArg | undefined {
	const call = [...path].reverse().find((n) => FunctionCallNode.is(n as core.AstNode)) as
		| core.DeepReadonly<FunctionCallNode>
		| undefined
	const fn = call?.target.symbol as core.Symbol | undefined
	if (!call || !fn) {
		return undefined
	}
	for (const range of callKeyRanges(text, call.target.range.end)) {
		if (core.Range.contains(range, offset, true)) {
			return { name: text.slice(range.start, range.end), range, fn }
		}
	}
	return undefined
}

/** `@arg x` at the cursor, in the doc block above a function. */
function argDocAt(path: readonly Node[], text: string, offset: number): MacroArg | undefined {
	const tag = docTagAt(text, offset, 'arg')
	const siblings = path[path.length - 2]?.children ?? path[0]?.children ?? []
	const def = tag && siblings.find((n) =>
		FunctionDefinitionNode.is(n as core.AstNode)
		&& docLinesAbove(text, n.range.start).some((l) => core.Range.contains(l, offset, true))
	) as core.DeepReadonly<FunctionDefinitionNode> | undefined
	const fn = def?.id.symbol as core.Symbol | undefined
	return tag && fn && { ...tag, fn }
}

/** Name ranges of `$(x)` uses in `range`, all of them or only those named `name`. */
function macroUses(text: string, range: core.Range, name?: string): core.Range[] {
	const ranges: core.Range[] = []
	for (const match of text.slice(range.start, range.end).matchAll(/\$\((\w+)\)/g)) {
		if (name === undefined || match[1] === name) {
			const start = range.start + match.index + 2
			ranges.push(core.Range.create(start, start + match[1].length))
		}
	}
	return ranges
}

/** Key name ranges in the literal `{…}` macro data after a call target ending at `end`. */
function callKeyRanges(text: string, end: number, name?: string): core.Range[] {
	const lineEnd = text.indexOf('\n', end)
	const rest = text.slice(end, lineEnd < 0 ? text.length : lineEnd)
	const data = /^\s*(\{.*\})\s*$/.exec(rest)
	const keys = data && compoundKeys(data[1])
	if (!data || !keys) {
		return []
	}
	const start = end + data[0].indexOf('{')
	return keys.filter((k) => name === undefined || k.name === name).map((k) => {
		const quoted = /^["']/.test(text[start + k.offset]) ? 1 : 0
		return core.Range.create(start + k.offset + quoted, start + k.offset + k.length - quoted)
	})
}

// #endregion
// #region doc blocks

/** The `#` lines directly above the line holding `offset`. */
function docLinesAbove(text: string, offset: number): core.Range[] {
	const lines: core.Range[] = []
	let end = text.lastIndexOf('\n', offset - 1)
	while (end > 0) {
		const start = text.lastIndexOf('\n', end - 1) + 1
		if (!/^\s*#/.test(text.slice(start, end))) {
			break
		}
		lines.unshift(core.Range.create(start, end))
		end = start - 1
	}
	return lines
}

/** `@tag x` at `offset`. */
function docTagAt(
	text: string,
	offset: number,
	tag: 'arg' | 'param',
): { name: string; range: core.Range } | undefined {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1
	const lineEnd = text.indexOf('\n', offset)
	const line = core.Range.create(lineStart, lineEnd < 0 ? text.length : lineEnd)
	const [range] = docTagRanges(text, [line], tag)
	return range && core.Range.contains(range, offset, true)
		? { name: text.slice(range.start, range.end), range }
		: undefined
}

/** Name ranges of `@tag x` in `lines`, all of them or only those named `name`. */
function docTagRanges(
	text: string,
	lines: readonly core.Range[],
	tag: 'arg' | 'param',
	name?: string,
): core.Range[] {
	const ranges: core.Range[] = []
	for (const line of lines) {
		const match = new RegExp(`^\\s*#.*?@${tag}\\s+(\\w+)`).exec(text.slice(line.start, line.end))
		if (match && (name === undefined || match[1] === name)) {
			const start = line.start + match[0].length - match[1].length
			ranges.push(core.Range.create(start, start + match[1].length))
		}
	}
	return ranges
}

// #endregion

/** Whether `offset` is inside a `<% %>` / `<%% %%>` script. */
export function isInScript(file: Node, offset: number): boolean {
	return pathTo(file, offset).at(-1)?.type === 'mcbuild:js'
}

function pathTo(root: Node, offset: number): Node[] {
	const path: Node[] = []
	for (
		let node: Node | undefined = root;
		node && core.Range.contains(node.range, offset, true);
		node = node.children?.find((c) => core.Range.contains(c.range, offset, true))
	) {
		path.push(node)
	}
	return path
}

function dedupe(ranges: readonly core.Range[]): core.Range[] {
	return ranges.filter((r, i) => ranges.findIndex((o) => o.start === r.start) === i)
}
