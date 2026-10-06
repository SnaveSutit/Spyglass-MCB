import type * as core from '@spyglassmc/core'
import { localeQuote, localize } from '@spyglassmc/locales'
import { fileBase } from './binder/index.js'

/**
 * Adds a missing function to the `.mcb` file mc-build maps its id to: the current file when the id
 * falls under it, else `src/<namespace>/<path>.mcb`. Other files keep the default quick fix.
 */
export const addFunction: core.UndeclaredSymbolAction = (identifier, ctx) => {
	const base = /\.mcbt?$/.test(ctx.doc.uri) ? fileBase(ctx.doc.uri) : undefined
	const [namespace, rawPath] = identifier.split(':', 2)
	if (!base || !rawPath) {
		return undefined
	}
	const segments = rawPath.split('/')
	const isUnderFile = namespace === base.namespace
		&& segments.length > base.path.length
		&& base.path.every((s, i) => segments[i] === s)
	let uri: string
	let name: string
	if (isUnderFile) {
		uri = ctx.doc.uri
		name = segments.slice(base.path.length).join('/')
	} else {
		const srcRoot = ctx.doc.uri.slice(0, ctx.doc.uri.lastIndexOf('/src/') + '/src/'.length)
		uri = `${srcRoot}${[namespace, ...segments.slice(0, -1)].join('/')}.mcb`
		name = segments[segments.length - 1]
	}
	return {
		title: localize('mcbuild.code-action.add-function', localeQuote(name), fileName(uri)),
		isPreferred: true,
		changes: [{ type: 'append', uri, text: `function ${name} {\n}\n` }],
	}
}

/** Adds a template named `name` to the `.mcbt` file at `uri`. */
export function addTemplate(name: string, uri: string): core.LanguageErrorAction {
	return {
		title: localize('mcbuild.code-action.add-template', localeQuote(name), fileName(uri)),
		isPreferred: true,
		changes: [{ type: 'append', uri, text: `template ${name} {\n\twith {\n\t}\n}\n` }],
	}
}

function fileName(uri: string): string {
	return decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1))
}
