import type { DeepReadonly } from '../common/index.js'
import type { AstNode } from '../node/index.js'
import type { CompleterContext } from '../service/index.js'
import type { CompletionItem } from './completer/index.js'

/**
 * Extra completion items that need async work, like reading the file system. They are added to
 * the language completer's items.
 */
export type CompletionProvider<N extends AstNode = AstNode> = (
	node: DeepReadonly<N>,
	ctx: CompleterContext,
) => Promise<CompletionItem[]>
