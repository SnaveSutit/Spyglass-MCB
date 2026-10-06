import * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import type { TextDocument } from 'vscode-languageserver-textdocument'
import { EntryNode } from './node/index.js'

/**
 * Candidate URIs for an `import`. `/`-paths resolve from the mc-build project dir (the one holding
 * `src/`), like mc-build; outside `src/`, from each root.
 */
export function resolveImport(spec: string, from: string, roots: readonly string[]): string[] {
	try {
		const srcIndex = from.lastIndexOf('/src/')
		if (spec.startsWith('/') && srcIndex >= 0) {
			return [new URL('.' + spec, from.slice(0, srcIndex + 1)).href]
		}
		if (spec.startsWith('/')) {
			return roots.map((root) =>
				new URL('.' + spec, root.endsWith('/') ? root : root + '/').href
			)
		}
		const rel = spec.startsWith('./') || spec.startsWith('../') ? spec : './' + spec
		return [new URL(rel, from).href]
	} catch {
		return []
	}
}

/** The URIs the file containing `node` imports. */
export function importedUris(
	node: core.DeepReadonly<core.AstNode>,
	ctx: { doc: TextDocument; roots: readonly string[] },
): string[] {
	let entry: core.DeepReadonly<core.AstNode> | undefined = node
	while (entry && !EntryNode.is(entry as core.AstNode)) {
		entry = entry.parent
	}
	const uris: string[] = []
	for (const child of entry?.children ?? []) {
		const spec = (child as { path?: { value: string } }).path?.value
		if (child.type === 'mcbuild:import' && spec) {
			uris.push(...resolveImport(spec, ctx.doc.uri, ctx.roots))
		}
	}
	return uris
}

/**
 * Whether a template defined at `definitions` is in scope at `node` like mc-build has it: defined
 * in this file or one it imports directly. Template bodies also see their caller's templates, so
 * everything is in scope there.
 */
export function isTemplateInScope(
	definitions: readonly core.SymbolLocation[] | undefined,
	node: core.DeepReadonly<core.AstNode>,
	ctx: { doc: TextDocument; roots: readonly string[] },
): boolean {
	for (let n: core.DeepReadonly<core.AstNode> | undefined = node; n; n = n.parent) {
		if (n.type === 'mcbuild:template_definition') {
			return true
		}
	}
	const visible = new Set([ctx.doc.uri, ...importedUris(node, ctx)])
	return definitions?.some((l) => visible.has(l.uri)) ?? false
}

/** `import <path>` for `target`, inserted after the file's last import (else at the top). */
export function importEdit(doc: TextDocument, target: string): { range: core.Range; text: string } {
	const text = doc.getText()
	let offset = 0
	for (const match of text.matchAll(/^[ \t]*import\b.*(?:\r?\n|$)/gm)) {
		offset = match.index + match[0].length
	}
	const separator = offset > 0 && !/\n$/.test(text.slice(0, offset)) ? '\n' : ''
	return {
		range: core.Range.create(offset, offset),
		text: `${separator}import ${relativeSpec(doc.uri, target)}\n`,
	}
}

/** Quick fix adding the import for a template defined in `target`. */
export function importAction(doc: TextDocument, target: string): core.LanguageErrorAction {
	const edit = importEdit(doc, target)
	return {
		title: localize('mcbuild.code-action.import', localeQuote(relativeSpec(doc.uri, target))),
		isPreferred: true,
		changes: [{ type: 'edit', ...edit }],
	}
}

/** `./x.mcbt` / `../dir/x.mcbt`, as mc-build relative imports are written. */
export function relativeSpec(from: string, to: string): string {
	const fromDir = from.split('/').slice(0, -1)
	const toParts = to.split('/')
	let common = 0
	while (common < fromDir.length && fromDir[common] === toParts[common]) {
		common++
	}
	const up = fromDir.length - common
	const rest = toParts.slice(common).map(decodeURIComponent).join('/')
	return up === 0 ? `./${rest}` : `${'../'.repeat(up)}${rest}`
}
