import type * as core from '@spyglassmc/core'
import type { CommandNode, MacroNode } from '@spyglassmc/mcfunction'

/** A bare name or keyword (function, template, param, schedule mode, ...). Never quoted. */
export interface IdentifierNode extends core.AstNode {
	type: 'mcbuild:identifier'
	value: string
	children?: undefined
}
export namespace IdentifierNode {
	export function is(node: core.AstNode | undefined): node is IdentifierNode {
		return (node as IdentifierNode | undefined)?.type === 'mcbuild:identifier'
	}
}

/** mc-build AST, mirroring mc-build's `src/mcl/AstNode.ts`. */

export type McbFileVariant = 'mcb' | 'mcbt'

export interface EntryNode extends core.AstNode {
	type: 'mcbuild:entry'
	variant: McbFileVariant
	children: McbNode[]
}
export namespace EntryNode {
	export function is(node: core.AstNode | undefined): node is EntryNode {
		return (node as EntryNode | undefined)?.type === 'mcbuild:entry'
	}
}

export type McbNode =
	| core.CommentNode
	| core.ErrorNode
	| FunctionDefinitionNode
	| DirectoryDefinitionNode
	| TemplateDefinitionNode
	| TemplateOverloadNode
	| ClockDefinitionNode
	| ImportNode
	| TickBlockNode
	| LoadBlockNode
	| CommandStatementNode
	| FunctionCallNode
	| ScheduleCallNode
	| ScheduleBlockNode
	| ScheduleClearNode
	| ExecuteBlockNode
	| ExecuteRunNode
	| BlockNode
	| ReturnRunNode
	| CompileTimeIfNode
	| CompileTimeLoopNode
	| MultilineScriptNode
	| JsonFileNode
	| TagEntryNode
	| EqStatementNode
	| ReferenceNode
	| JsNode

/** A brace-delimited `{ ... }` body. */
export interface BodyNode extends core.AstNode {
	type: 'mcbuild:body'
	/** Text after the `{` (`block foo { {a:1}` -> `{a:1}`). */
	data?: JsNode | IdentifierNode
	children: McbNode[]
}

// #region definitions

export interface FunctionDefinitionNode extends core.AstNode {
	type: 'mcbuild:function_definition'
	id: IdentifierNode
	/** Function tag to append to: `function f minecraft:load { }`. */
	appendTo?: core.ResourceLocationNode
	body?: BodyNode
	children: core.AstNode[]
}
export namespace FunctionDefinitionNode {
	export function is(
		node: core.AstNode | undefined,
	): node is FunctionDefinitionNode {
		return (
			(node as FunctionDefinitionNode | undefined)?.type
				=== 'mcbuild:function_definition'
		)
	}
}

export interface DirectoryDefinitionNode extends core.AstNode {
	type: 'mcbuild:directory_definition'
	id: IdentifierNode
	body?: BodyNode
	children: core.AstNode[]
}
export namespace DirectoryDefinitionNode {
	export function is(
		node: core.AstNode | undefined,
	): node is DirectoryDefinitionNode {
		return (
			(node as DirectoryDefinitionNode | undefined)?.type
				=== 'mcbuild:directory_definition'
		)
	}
}

export interface TemplateDefinitionNode extends core.AstNode {
	type: 'mcbuild:template_definition'
	id: IdentifierNode
	overloads: TemplateOverloadNode[]
	children: core.AstNode[]
}
export namespace TemplateDefinitionNode {
	export function is(
		node: core.AstNode | undefined,
	): node is TemplateDefinitionNode {
		return (
			(node as TemplateDefinitionNode | undefined)?.type
				=== 'mcbuild:template_definition'
		)
	}
}

export type TemplateArgKind =
	| 'int'
	| 'float'
	| 'word'
	| 'raw'
	| 'js'
	| 'block'
	| 'literal'

/** One `with` param: typed (`a:int`) or a literal to match (`foo`, `name` = the text). */
export interface TemplateArgNode extends core.AstNode {
	type: 'mcbuild:template_arg'
	name: IdentifierNode
	kind: TemplateArgKind
	children: core.AstNode[]
}

/** One `with [params] { }` overload of a `template`. */
export interface TemplateOverloadNode extends core.AstNode {
	type: 'mcbuild:template_overload'
	params: TemplateArgNode[]
	body?: BodyNode
	children: core.AstNode[]
}
export namespace TemplateOverloadNode {
	export function is(
		node: core.AstNode | undefined,
	): node is TemplateOverloadNode {
		return (
			(node as TemplateOverloadNode | undefined)?.type
				=== 'mcbuild:template_overload'
		)
	}
}

export interface ClockDefinitionNode extends core.AstNode {
	type: 'mcbuild:clock_definition'
	id: IdentifierNode
	time: core.AstNode
	body?: BodyNode
	children: core.AstNode[]
}
export namespace ClockDefinitionNode {
	export function is(node: core.AstNode | undefined): node is ClockDefinitionNode {
		return (node as ClockDefinitionNode | undefined)?.type === 'mcbuild:clock_definition'
	}
}

export interface ImportNode extends core.AstNode {
	type: 'mcbuild:import'
	path: IdentifierNode
	children: core.AstNode[]
}
export namespace ImportNode {
	export function is(node: core.AstNode | undefined): node is ImportNode {
		return (node as ImportNode | undefined)?.type === 'mcbuild:import'
	}
}

export interface TickBlockNode extends core.AstNode {
	type: 'mcbuild:tick_block'
	body?: BodyNode
	children: core.AstNode[]
}

export interface LoadBlockNode extends core.AstNode {
	type: 'mcbuild:load_block'
	body?: BodyNode
	children: core.AstNode[]
}

// #endregion
// #region statements

export interface MacroPrefixNode extends core.AstNode {
	type: 'mcbuild:macro_prefix'
}

/**
 * A command line, or a template call when its first word names a template
 * (decided by the checker; mc-build doesn't distinguish them syntactically).
 */
export interface CommandStatementNode extends core.AstNode {
	type: 'mcbuild:command'
	macro?: MacroPrefixNode
	/** Absent when the line has `<%js%>` interpolation. */
	command?: CommandNode | MacroNode
	/** Alternating literal / JS parts of an interpolated line. */
	interpolation?: (IdentifierNode | JsNode)[]
	/** Same-line `{ }` block argument of a template call. */
	trailing?: BlockNode
	/** Command errors the checker reports only if this isn't a template call. Non-enumerable. */
	deferredErrors?: readonly core.LanguageError[]
	children: core.AstNode[]
}
export namespace CommandStatementNode {
	export function is(
		node: core.AstNode | undefined,
	): node is CommandStatementNode {
		return (
			(node as CommandStatementNode | undefined)?.type === 'mcbuild:command'
		)
	}
}

export interface FunctionCallNode extends core.AstNode {
	type: 'mcbuild:function_call'
	macro?: MacroPrefixNode
	target: ReferenceNode
	/** Macro data: `function foo {with ...}` / `function foo <%js%>`. */
	data?: JsNode | IdentifierNode
	children: core.AstNode[]
}
export namespace FunctionCallNode {
	export function is(node: core.AstNode | undefined): node is FunctionCallNode {
		return (
			(node as FunctionCallNode | undefined)?.type === 'mcbuild:function_call'
		)
	}
}

export interface ScheduleCallNode extends core.AstNode {
	type: 'mcbuild:schedule_call'
	macro?: MacroPrefixNode
	target: ReferenceNode
	time: core.AstNode
	mode?: IdentifierNode
	children: core.AstNode[]
}

export interface ScheduleBlockNode extends core.AstNode {
	type: 'mcbuild:schedule_block'
	macro?: MacroPrefixNode
	time: core.AstNode
	mode?: IdentifierNode
	body?: BodyNode
	children: core.AstNode[]
}

export interface ScheduleClearNode extends core.AstNode {
	type: 'mcbuild:schedule_clear'
	macro?: MacroPrefixNode
	target: ReferenceNode
	children: core.AstNode[]
}

/** `execute <args> run { }` */
export interface ExecuteBlockNode extends core.AstNode {
	type: 'mcbuild:execute_block'
	macro?: MacroPrefixNode
	/** The command up to and including `run`. */
	execute: CommandStatementNode
	body?: BodyNode
	/** `else run { }` / `else <exec> run { }` */
	continuations: (BlockNode | ExecuteBlockNode)[]
	children: core.AstNode[]
}
export namespace ExecuteBlockNode {
	export function is(node: core.AstNode | undefined): node is ExecuteBlockNode {
		return (
			(node as ExecuteBlockNode | undefined)?.type === 'mcbuild:execute_block'
		)
	}
}

/** `execute <args> run <statement>` */
export interface ExecuteRunNode extends core.AstNode {
	type: 'mcbuild:execute_run'
	macro?: MacroPrefixNode
	execute: CommandStatementNode
	statement?: McbNode
	children: core.AstNode[]
}

/** `block [name] { }` */
export interface BlockNode extends core.AstNode {
	type: 'mcbuild:block'
	macro?: MacroPrefixNode
	/** May contain `<%js%>` spans. */
	name?: (IdentifierNode | JsNode)[]
	body?: BodyNode
	children: core.AstNode[]
}
export namespace BlockNode {
	export function is(node: core.AstNode | undefined): node is BlockNode {
		return (node as BlockNode | undefined)?.type === 'mcbuild:block'
	}
}

export interface ReturnRunNode extends core.AstNode {
	type: 'mcbuild:return_run'
	macro?: MacroPrefixNode
	value?: McbNode
	children: core.AstNode[]
}

// #endregion
// #region control flow

export interface CompileTimeIfNode extends core.AstNode {
	type: 'mcbuild:compiletime_if'
	condition: JsNode
	body?: BodyNode
	elifs: { condition?: JsNode; body?: BodyNode }[]
	children: core.AstNode[]
}

export interface CompileTimeLoopNode extends core.AstNode {
	type: 'mcbuild:compiletime_loop'
	expression: JsNode
	/** `as a,b` */
	vars: IdentifierNode[]
	body?: BodyNode
	children: core.AstNode[]
}

export interface MultilineScriptNode extends core.AstNode {
	type: 'mcbuild:multiline_script'
	script: JsNode
	children: core.AstNode[]
}

// #endregion
// #region data files

export type JsonFileKind =
	| 'tag'
	| 'advancement'
	| 'enchantment'
	| 'item_modifier'
	| 'loot_table'
	| 'predicate'
	| 'recipe'
	| 'chat_type'
	| 'damage_type'
	| 'dimension'
	| 'dimension_type'
	| 'worldgen'

export interface JsonFileNode extends core.AstNode {
	type: 'mcbuild:json_file'
	kind: JsonFileKind
	/** `tag` / `worldgen` registry. */
	registry?: IdentifierNode
	id: IdentifierNode
	replace?: core.AstNode
	/** Tag entries, or the typed JSON body. */
	entries: (TagEntryNode | core.AstNode)[]
	children: core.AstNode[]
}
export namespace JsonFileNode {
	export function is(node: core.AstNode | undefined): node is JsonFileNode {
		return (node as JsonFileNode | undefined)?.type === 'mcbuild:json_file'
	}
}

export interface TagEntryNode extends core.AstNode {
	type: 'mcbuild:tag_entry'
	value: ReferenceNode | core.ResourceLocationNode | JsNode
	replace?: core.AstNode
	children: core.AstNode[]
}

// #endregion
// #region references

export type ReferenceScheme =
	/** `*abs/path` */
	| 'absolute'
	/** `./rel`, `../rel` */
	| 'relative'
	/** `^0`, `^1`, ...: an enclosing block */
	| 'parent'
	/** `namespace:path` */
	| 'id'

export interface ReferenceNode extends core.AstNode {
	type: 'mcbuild:reference'
	scheme: ReferenceScheme
	/** `#`-prefixed function tag reference. */
	isTag: boolean
	/** `N` of a `^N` reference. */
	depth?: number
	/** Path after the `#` / `*` / `^N` sigil. */
	path: string
	/** Resolved id, set by the binder. */
	resolved?: string
}
export namespace ReferenceNode {
	export function is(node: core.AstNode | undefined): node is ReferenceNode {
		return (node as ReferenceNode | undefined)?.type === 'mcbuild:reference'
	}
}

// #endregion
// #region eq expressions

export interface EqStatementNode extends core.AstNode {
	type: 'mcbuild:eq_statement'
	target: EqOperandNode
	operator: core.AstNode
	expression: EqExpressionNode
	children: core.AstNode[]
}
export namespace EqStatementNode {
	export function is(node: core.AstNode | undefined): node is EqStatementNode {
		return (
			(node as EqStatementNode | undefined)?.type === 'mcbuild:eq_statement'
		)
	}
}

export type EqExpressionNode =
	| EqBinaryNode
	| EqUnaryNode
	| EqOperandNode
	| EqLiteralNode
	| EqSelectorOperandNode
	| core.ErrorNode

export interface EqBinaryNode extends core.AstNode {
	type: 'mcbuild:eq_binary'
	operator: core.AstNode
	left: EqExpressionNode
	right: EqExpressionNode
	children: core.AstNode[]
}

export interface EqUnaryNode extends core.AstNode {
	type: 'mcbuild:eq_unary'
	operator: core.AstNode
	operand: EqExpressionNode
	children: core.AstNode[]
}

/** `<holder> <objective>` */
export interface EqOperandNode extends core.AstNode {
	type: 'mcbuild:eq_operand'
	holder: IdentifierNode
	objective: IdentifierNode
	children: core.AstNode[]
}

/** `<selector> <objective>` */
export interface EqSelectorOperandNode extends core.AstNode {
	type: 'mcbuild:eq_selector_operand'
	selector: core.AstNode
	objective: IdentifierNode
	children: core.AstNode[]
}

export interface EqLiteralNode extends core.AstNode {
	type: 'mcbuild:eq_literal'
	value: number
	children?: undefined
}

// #endregion
// #region embedded JavaScript

/** Embedded JS: `<% %>`, `<%% %%>`, `REPEAT(...)`, `IF(...)`. */
export interface JsNode extends core.AstNode {
	type: 'mcbuild:js'
	context: 'inline' | 'multiline' | 'expression'
	source: string
	/** Whether a syntax error was reported. */
	loose: boolean
	children?: undefined
}
export namespace JsNode {
	export function is(node: core.AstNode | undefined): node is JsNode {
		return (node as JsNode | undefined)?.type === 'mcbuild:js'
	}
}

// #endregion
