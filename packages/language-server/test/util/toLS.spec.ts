import type * as core from '@spyglassmc/core'
import { showWhitespaceGlyph } from '@spyglassmc/core/test/utils.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'
import type * as ls from 'vscode-languageserver/node.js'
import { codeAction, completionItem, semanticTokens } from '../../lib/util/toLS.js'

/**
 * The result of decoding a semantic token from an integer list.
 * The VSCode API documentation details what the integer list represents here:
 * https://code.visualstudio.com/api/references/vscode-api#DocumentSemanticTokensProvider.provideDocumentSemanticTokens
 */
interface DecodedSemanticToken {
	deltaLine: number
	deltaStartChar: number
	length: number
	tokenType: number
	tokenModifiers: number
}
const decodeSemanticTokens = (tokens: ls.SemanticTokens['data']): DecodedSemanticToken[] => {
	if (tokens.length % 5 !== 0) {
		throw new Error('Array of semantic tokens must be divisible by 5')
	}
	const decodedTokens = []
	for (let i = 0; i < tokens.length; i += 5) {
		const decodedToken = {
			deltaLine: tokens[i],
			deltaStartChar: tokens[i + 1],
			length: tokens[i + 2],
			tokenType: tokens[i + 3],
			tokenModifiers: tokens[i + 4],
		}
		decodedTokens.push(decodedToken)
	}
	return decodedTokens
}

describe('semanticTokens', () => {
	const tokens: core.ColorToken[] = [{ range: { start: 0, end: 100 }, type: 'comment' }]
	const suites: { content: string }[] = [{ content: 'foo' }, { content: 'foo\nbar' }, {
		content: 'foo\nbar\nqux',
	}]
	for (const hasMultilineTokenSupport of [true, false]) {
		for (const { content } of suites) {
			const doc = TextDocument.create('file:///test', '', 0, content)
			const multilineStr = `${
				hasMultilineTokenSupport ? 'with' : 'without'
			} multiline token support`
			const itTitle = `Tokenize "${showWhitespaceGlyph(content)}" ${multilineStr}`
			it(itTitle, (t) => {
				const { data } = semanticTokens(tokens, doc, hasMultilineTokenSupport)
				t.assert.snapshot(decodeSemanticTokens(data))
			})
		}
	}
})

describe('codeAction() append changes', () => {
	const doc = TextDocument.create('file:///a.mcb', 'mc-build', 0, '')
	const action: core.CodeAction = {
		title: 'Add',
		changes: [{ type: 'append', uri: 'file:///b.mcb', text: 'function x {\n}\n' }],
	}

	it('inserts at the end of an existing file, after a blank line', () => {
		const target = TextDocument.create('file:///b.mcb', 'mc-build', 0, 'function a {\n}\n')
		const changes = codeAction(action, doc, new Map([[target.uri, target]])).edit?.documentChanges
		assert.deepEqual(changes, [{
			// eslint-disable-next-line no-restricted-syntax
			textDocument: { uri: 'file:///b.mcb', version: null },
			edits: [{
				range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
				newText: '\nfunction x {\n}\n',
			}],
		}])
	})

	it('creates a missing file before writing to it', () => {
		const changes = codeAction(action, doc, new Map([['file:///b.mcb', undefined]])).edit
			?.documentChanges
		assert.deepEqual(changes, [
			{ kind: 'create', uri: 'file:///b.mcb', options: { ignoreIfExists: true } },
			{
				// eslint-disable-next-line no-restricted-syntax
				textDocument: { uri: 'file:///b.mcb', version: null },
				edits: [{
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
					newText: 'function x {\n}\n',
				}],
			},
		])
	})
})

describe('completionItem()', () => {
	it('maps additional edits', () => {
		const doc = TextDocument.create('file:///a.mcb', 'mc-build', 0, 'function t {\n\tgr\n}\n')
		const item = completionItem(
			{
				label: 'greet',
				range: { start: 14, end: 16 },
				additionalEdits: [{ range: { start: 0, end: 0 }, text: 'import ./t.mcbt\n' }],
			},
			doc,
			16,
			false,
		)
		assert.deepEqual(item.additionalTextEdits, [{
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
			newText: 'import ./t.mcbt\n',
		}])
	})
})
