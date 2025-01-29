import * as core from '@spyglassmc/core'
import type * as mcf from '@spyglassmc/mcfunction'
import fs from 'fs'
import type { McmetaCommands } from '../dependency/index.js'
import { ReleaseVersion } from '../dependency/index.js'
import { getPatch } from '../mcfunction/tree/patch.js'
import * as completer from './completer/index.js'
import * as parser from './parser/index.js'

export const initialize = (
	ctx: core.ProjectInitializerContext,
	commands: McmetaCommands,
	releaseVersion: ReleaseVersion,
) => {
	const { meta } = ctx

	const tree = core.merge(commands, getPatch(releaseVersion))
	const mcfunctionOptions: mcf.McfunctionOptions = {
		lineContinuation: ReleaseVersion.cmp(releaseVersion, '1.20.2') >= 0,
		macros: ReleaseVersion.cmp(releaseVersion, '1.20.2') >= 0,
		commandOptions: ReleaseVersion.cmp(releaseVersion, '1.20.5') >= 0
			? { maxLength: 2_000_000 }
			: {},
	}

	meta.registerLanguage('mcbuild', {
		extensions: ['.mcb'],
		parser(src, ctx) {
			const result = parser.entry(tree, mcfunctionOptions)(src, ctx)
			fs.writeFileSync(
				'C:/Users/SnaveSutit/Desktop/mcbuild.json',
				JSON.stringify(result, undefined, '\t'),
			)
			ctx.logger.info(result)
			return result
		},
	})

	completer.register(meta)
}
