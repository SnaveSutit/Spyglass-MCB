import * as core from '@spyglassmc/core'
import { McfunctionNode } from '@spyglassmc/mcfunction'
import { ComponentTestExactNode, ComponentTestSubpredicateNode } from '../../mcfunction/node'
import type { McbuildNode } from '../node'

const componentTests: core.Completer<McbuildNode> = (node, ctx) => {
	// TODO: improve this completer
	const test = core.AstNode.findShallowestChild({
		node: node as core.Mutable<McbuildNode>,
		needle: ctx.offset,
		endInclusive: true,
		predicate: (n) => McfunctionNode.is(n),
	})
	if (test) {
		return core.completer.dispatch(test, ctx)
	}
	return []
}

export function register(meta: core.MetaRegistry): void {
	meta.registerCompleter('mcbuild:entry', componentTests)
}
