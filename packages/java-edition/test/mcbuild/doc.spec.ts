import { compoundKeys } from '@spyglassmc/java-edition/lib/mcbuild/checker/index.js'
import { parseDocComment, renderDocComment } from '@spyglassmc/java-edition/lib/mcbuild/doc.js'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('mcbuild parseDocComment()', () => {
	it('splits the text from tags', () => {
		const doc = parseDocComment([
			'> Shows a message',
			'',
			'Queue only.',
			'@arg message {TextComponent} Text to show',
			'@arg delay Ticks to wait',
			'@param mode {word} How to show it',
			'@deprecated Use ./broadcast',
			'@within ./queue/*',
		])
		assert.deepEqual(doc, {
			text: 'Shows a message\n\nQueue only.',
			args: [
				{ name: 'message', type: 'TextComponent', desc: 'Text to show' },
				{ name: 'delay', type: undefined, desc: 'Ticks to wait' },
			],
			params: [{ name: 'mode', type: 'word', desc: 'How to show it' }],
			deprecated: 'Use ./broadcast',
			within: ['./queue/*'],
		})
	})

	it('allows a bare @deprecated and an empty title', () => {
		const doc = parseDocComment(['>', '@deprecated'])
		assert.equal(doc.text, '')
		assert.equal(doc.deprecated, '')
	})
})

describe('mcbuild renderDocComment()', () => {
	it('renders markdown sections', () => {
		const doc = parseDocComment([
			'> Shows a message',
			'@arg message {TextComponent} Text to show',
			'@deprecated',
			'@within ./queue/*',
		])
		assert.equal(
			renderDocComment(doc),
			'**Deprecated**\n\nShows a message\n\n**Arguments**\n- `message`: `TextComponent` — Text to show'
				+ '\n\n**Within**: `./queue/*`',
		)
	})
})

describe('mcbuild compoundKeys()', () => {
	it('lists top-level keys and values with their offsets', () => {
		assert.deepEqual(compoundKeys('{a:1, "b c": {d:2}, \'e\':[{f:3}]}'), [
			{ name: 'a', offset: 1, length: 1, value: { text: '1', offset: 3 } },
			{ name: 'b c', offset: 6, length: 5, value: { text: '{d:2}', offset: 13 } },
			{ name: 'e', offset: 20, length: 3, value: { text: '[{f:3}]', offset: 24 } },
		])
	})

	it('skips non-literal data', () => {
		assert.equal(compoundKeys('with storage a:b path'), undefined)
		assert.equal(compoundKeys('{a:<%x%>}'), undefined)
		assert.equal(compoundKeys('{a:$(x)}'), undefined)
		assert.equal(compoundKeys('{a:1'), undefined)
	})
})
