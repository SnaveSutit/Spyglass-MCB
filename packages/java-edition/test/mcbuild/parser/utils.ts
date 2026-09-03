import { entry, type McbParserOptions } from '@spyglassmc/java-edition/lib/mcbuild/parser/index.js'
import { argument as jeArgument } from '@spyglassmc/java-edition/lib/mcfunction/parser/index.js'
import type * as mcf from '@spyglassmc/mcfunction'

/** A minimal command tree for the commands the tests use. */
export const tree: mcf.RootTreeNode = {
	type: 'root',
	children: {
		say: {
			type: 'literal',
			children: {
				message: {
					type: 'argument',
					parser: 'brigadier:string',
					properties: { type: 'greedy' },
					executable: true,
				},
			},
		},
		function: {
			type: 'literal',
			children: {
				name: {
					type: 'argument',
					parser: 'minecraft:resource_location',
					properties: { pool: 'function', allowTag: true },
					executable: true,
				},
			},
		},
		scoreboard: {
			type: 'literal',
			children: {
				players: {
					type: 'literal',
					children: {
						set: {
							type: 'literal',
							children: {
								target: {
									type: 'argument',
									parser: 'minecraft:score_holder',
									properties: { amount: 'single' },
									children: {
										objective: {
											type: 'argument',
											parser: 'minecraft:objective',
											children: {
												score: {
													type: 'argument',
													parser: 'brigadier:integer',
													executable: true,
												},
											},
										},
									},
								},
							},
						},
					},
				},
				objectives: {
					type: 'literal',
					children: {
						add: {
							type: 'literal',
							children: {
								objective: {
									type: 'argument',
									parser: 'brigadier:string',
									properties: { type: 'word' },
									children: {
										criteria: {
											type: 'argument',
											parser: 'minecraft:objective_criteria',
											executable: true,
										},
									},
								},
							},
						},
					},
				},
			},
		},
		execute: {
			type: 'literal',
			children: {
				if: {
					type: 'literal',
					children: {
						score: {
							type: 'literal',
							children: {
								target: {
									type: 'argument',
									parser: 'minecraft:score_holder',
									properties: { amount: 'single' },
									children: {
										targetObjective: {
											type: 'argument',
											parser: 'minecraft:objective',
											children: {
												matches: {
													type: 'literal',
													children: {
														range: {
															type: 'argument',
															parser: 'minecraft:int_range',
															children: {
																run: {
																	type: 'literal',
																	children: {
																		subcommand: {
																			type: 'literal',
																			redirect: [],
																			executable: true,
																		},
																	},
																},
															},
														},
													},
												},
											},
										},
									},
								},
							},
						},
					},
				},
				as: {
					type: 'literal',
					children: {
						targets: {
							type: 'argument',
							parser: 'minecraft:entity',
							properties: { amount: 'multiple', type: 'entities' },
							redirect: ['execute'],
						},
					},
				},
				at: {
					type: 'literal',
					children: {
						targets: {
							type: 'argument',
							parser: 'minecraft:entity',
							properties: { amount: 'multiple', type: 'entities' },
							redirect: ['execute'],
						},
					},
				},
				run: {
					type: 'literal',
					children: { subcommand: { type: 'literal', redirect: [], executable: true } },
				},
			},
		},
	},
} as unknown as mcf.RootTreeNode

/** No argument parsers, so snapshots stay small and stable. */
const stubArgument: mcf.ArgumentParserGetter = () => undefined

/** The real java-edition argument parsers. */
export const realArgument: mcf.ArgumentParserGetter = jeArgument

export function mcbParser(
	argument: mcf.ArgumentParserGetter = stubArgument,
): ReturnType<typeof entry> {
	const options: McbParserOptions = { tree, argument, commandOptions: {} }
	return entry(options)
}
