import type { DeepReadonly } from '../common/index.js'
import type { AstNode } from '../node/index.js'
import type { DefinitionProviderContext, SymbolLocations } from '../service/index.js'

/**
 * Where the thing at the cursor is defined, for things that aren't symbols, like the file an
 * import names. `undefined` lets the next provider, then symbols, answer.
 */
export type DefinitionProvider<N extends AstNode = AstNode> = (
	node: DeepReadonly<N>,
	ctx: DefinitionProviderContext,
) => Promise<SymbolLocations | undefined> | SymbolLocations | undefined
