import type * as core from '@spyglassmc/core'
import type { TemplateParamData } from './binder/index.js'
import { getTemplateData, TEMPLATE_CATEGORY } from './binder/index.js'
import type { DocComment } from './doc.js'
import { paramType } from './doc.js'
import { EntryNode } from './node/index.js'

/** Signature help for a template call, one signature per overload. */
export const templateSignatureHelp: core.SignatureHelpProvider<core.FileNode<core.AstNode>> = (
	file,
	ctx,
) => {
	if (!EntryNode.is(file.children[0] as core.AstNode | undefined)) {
		return undefined
	}
	const call = templateCallAt(file, ctx)
	const data = getTemplateData(call?.symbol as core.Symbol | undefined)
	if (!call || !data || data.overloads.length === 0) {
		return undefined
	}
	const typed = ctx.doc.getText().slice(call.range.start, ctx.offset)
	const word = /^\s*\$?\s*(?:template\s+)?([A-Za-z_][\w./-]*)/.exec(typed)
	if (!word) {
		return undefined
	}
	const args = [...typed.slice(word[0].length).matchAll(/<%[^]*?%>|\S+/g)]
	const index = /\s$/.test(typed) ? args.length : Math.max(args.length - 1, 0)
	const signatures = data.overloads.map(({ params, doc }): core.SignatureInfo => {
		let label = word[1]
		const parameters: core.ParameterInfo[] = []
		for (const param of params) {
			label += ' '
			const text = param.kind === 'literal' ? param.name : `${param.name}:${param.kind}`
			parameters.push({
				label: [label.length, label.length + text.length],
				documentation: paramDocs(param.name, doc, data.doc),
			})
			label += text
		}
		return {
			label,
			documentation: doc?.text || data.doc?.text || undefined,
			parameters,
			activeParameter: activeParam(params, index),
		}
	})
	const fitting = data.overloads.findIndex(({ params }) => activeParam(params, index) >= 0)
	return { signatures, activeSignature: Math.max(fitting, 0) }
}

/** `` `Type` — description `` for a param, from the `with` overload's doc, else the template's. */
function paramDocs(
	name: string,
	overloadDoc: DocComment | undefined,
	templateDoc: DocComment | undefined,
): string | undefined {
	const desc = overloadDoc?.params.find((p) => p.name === name)?.desc
		|| templateDoc?.params.find((p) => p.name === name)?.desc
	const type = paramType(name, overloadDoc, templateDoc)
	return [type && `\`${type}\``, desc].filter(Boolean).join(' — ') || undefined
}

/** The param the `index`th word goes to: `block` params take no word, `raw` takes the rest. */
function activeParam(params: readonly TemplateParamData[], index: number): number {
	let word = 0
	for (const [i, param] of params.entries()) {
		if (param.kind === 'block') {
			continue
		}
		if (param.kind === 'raw' || word === index) {
			return i
		}
		word++
	}
	return -1
}

/** The last template call starting on the cursor's line before it. */
function templateCallAt(
	root: core.DeepReadonly<core.AstNode>,
	ctx: core.SignatureHelpProviderContext,
): core.DeepReadonly<core.AstNode> | undefined {
	const lineStart = ctx.doc.getText().lastIndexOf('\n', ctx.offset - 1) + 1
	let best: core.DeepReadonly<core.AstNode> | undefined
	const visit = (n: core.DeepReadonly<core.AstNode>) => {
		if (
			n.type === 'mcbuild:command' && n.symbol?.category === TEMPLATE_CATEGORY
			&& n.range.start >= lineStart && n.range.start <= ctx.offset
		) {
			best = n
		}
		for (const c of n.children ?? []) {
			visit(c)
		}
	}
	visit(root)
	return best
}
