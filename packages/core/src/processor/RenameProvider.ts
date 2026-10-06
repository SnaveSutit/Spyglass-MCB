import type { TextDocument } from 'vscode-languageserver-textdocument'
import type { DeepReadonly } from '../common/index.js'
import type { AstNode } from '../node/index.js'
import type { RenameProviderContext } from '../service/index.js'
import type { Range } from '../source/index.js'

export interface RenameEdit {
	range: Range
	text: string
}

export interface DocumentRenameEdits {
	doc: TextDocument
	edits: RenameEdit[]
}

export interface RenameTarget {
	/** The name being renamed, in the current document. */
	range: Range
	placeholder: string
	/** Edits renaming it to `newName` across files, or a message saying why it can't be. */
	rename(newName: string): Promise<DocumentRenameEdits[] | string>
}

/**
 * The rename target at the cursor, a message saying why it can't be renamed, or `undefined` to
 * let another provider try.
 */
export type RenameProvider<N extends AstNode = AstNode> = (
	node: DeepReadonly<N>,
	ctx: RenameProviderContext,
) => Promise<RenameTarget | string | undefined> | RenameTarget | string | undefined
