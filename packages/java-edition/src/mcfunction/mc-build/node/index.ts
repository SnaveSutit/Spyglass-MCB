import type * as core from '@spyglassmc/core'

export interface MCBNode extends core.AstNode {
	type: 'mcbuild:entry'
	children: MCBDirContextNode[]
}

export namespace MCBNode {
	export function is(node: core.AstNode | undefined): node is MCBNode {
		return (node as MCBNode | undefined)?.type === 'mcbuild:entry'
	}
}

export interface MCBVanillaCommand extends core.AstNode {
	type: 'mcbuild:vanilla_command'
	children: Array<core.AstNode>
}

export interface MCBJSBlockCommand extends core.AstNode {
	type: 'mcbuild:js_block_command'
	children: Array<core.StringNode | MCBInlineJSBlock>
}

export interface MCBStringWithInlineJSBlock extends core.AstNode {
	type: 'mcbuild:string_with_inline_js_block'
	children: Array<core.StringNode | MCBInlineJSBlock>
}

export interface MCBInlineJSBlock extends core.AstNode {
	type: 'mcbuild:inline_js_block'
}

export interface MCBMultilineJSBlock extends core.AstNode {
	type: 'mcbuild:multiline_js_block'
}

export interface MCBFunctionBlockArgumentsNode extends core.AstNode {
	type: 'mcbuild:function_block_arguments'
}

export interface MCBFunctionBlockNode extends core.AstNode {
	type: 'mcbuild:function_block'
	children: core.AstNode[]
}

export interface MCBFunctionDefinitionNode extends core.AstNode {
	type: 'mcbuild:function_definition'
}

export interface MCBDirectoryDefinitionNode extends core.AstNode {
	type: 'mcbuild:directory_definition'
}

export type MCBDirContextNode =
	| core.CommentNode
	| MCBFunctionDefinitionNode
	| MCBDirectoryDefinitionNode
