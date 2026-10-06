import type * as core from '@spyglassmc/core'
import * as mcf from '@spyglassmc/mcfunction'
import * as binder from './binder/index.js'
import * as checker from './checker/index.js'
import * as completer from './completer/index.js'
import { entry } from './parser/index.js'

export * as binder from './binder/index.js'
export * as checker from './checker/index.js'
export * as completer from './completer/index.js'
export * from './node/index.js'
export * as parser from './parser/index.js'
export { tokenize } from './tokenizer.js'

export interface McbInitOptions {
	tree: mcf.RootTreeNode
	argument: mcf.ArgumentParserGetter
	mcfunctionOptions: mcf.McfunctionOptions
	getMockNodes: mcf.completer.MockNodesGetter
}

/** Language IDs from the `snavesutit-language-langmc` extension, which owns highlighting. */
export const LANGUAGE_ID = 'mc-build'
export const TEMPLATE_LANGUAGE_ID = 'mc-build-template'

/** Registers `.mcb` / `.mcbt`, reusing the Java command tree and argument parsers. */
export const initialize = (
	ctx: core.ProjectInitializerContext,
	options: McbInitOptions,
): void => {
	const { meta } = ctx
	const commandOptions = options.mcfunctionOptions.commandOptions ?? {}
	const triggerCharacters = [
		' ',
		'{',
		':',
		'/',
		'.',
		'<',
		'%',
		'#',
		'^',
		'*',
		'(',
		'"',
		"'",
		'=',
	]
	const parser = entry({
		tree: options.tree,
		argument: options.argument,
		commandOptions,
	})
	const completerEntry = completer.entry({
		command: mcf.completer.command(options.tree, options.getMockNodes),
	})

	meta.registerLanguage(LANGUAGE_ID, {
		extensions: ['.mcb'],
		triggerCharacters,
		parser,
		completer: completerEntry,
		recheckOnCrossFileChange: true,
	})
	meta.registerLanguage(TEMPLATE_LANGUAGE_ID, {
		extensions: ['.mcbt'],
		triggerCharacters,
		parser,
		completer: completerEntry,
		recheckOnCrossFileChange: true,
	})

	// mc-build regenerates `data/` next to its config on every build.
	for (const ext of ['.cjs', '.js', '.json']) {
		meta.registerGeneratedFolder(`mcb.config${ext}`, 'data')
	}
	binder.register(meta)
	checker.register(meta)
}
