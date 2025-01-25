import type * as core from '@spyglassmc/core'

export interface McbuildNode extends core.AstNode {
	type: 'mcbuild:entry'
	children: TopLevelNode[]
}

export namespace McbuildNode {
	export function is(node: core.AstNode | undefined): node is McbuildNode {
		return (node as McbuildNode | undefined)?.type === 'mcbuild:entry'
	}
}

export interface McbuildFunctionBlockNode extends core.AstNode {
	type: 'mcbuild:function_block'
}

export interface McbuildFunctionDefinitionNode extends core.AstNode {
	type: 'mcbuild:function_definition'
}

export interface McbuildDirectoryDefinitionNode extends core.AstNode {
	type: 'mcbuild:directory_definition'
}

export type TopLevelNode = McbuildFunctionDefinitionNode | McbuildDirectoryDefinitionNode
