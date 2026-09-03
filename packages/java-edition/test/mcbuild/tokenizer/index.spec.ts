import { showWhitespaceGlyph } from '@spyglassmc/core/test/utils.ts'
import { tokenize } from '@spyglassmc/java-edition/lib/mcbuild/tokenizer.js'
import { describe, it } from 'node:test'

/** Renders tokens with the source slice each covers. */
function render(source: string) {
	return tokenize(source).map((token) => {
		const slice = source.slice(token.range.start, token.range.end)
		const base = {
			type: token.type,
			range: `[${token.range.start}, ${token.range.end})`,
			source: showWhitespaceGlyph(slice),
		}
		if (token.type === 'literal') {
			return { ...base, value: showWhitespaceGlyph(token.value) }
		}
		if (token.type === 'bracket_open') {
			return {
				...base,
				data: token.data === undefined ? '(none)' : showWhitespaceGlyph(token.data),
			}
		}
		return base
	})
}

describe('mcbuild tokenize()', () => {
	const cases: { name: string; content: string }[] = [
		{ name: 'empty', content: '' },
		{ name: 'single command', content: 'say hi' },
		{ name: 'function definition', content: 'function test {\n\tsay hi\n}' },
		{ name: 'brace on same line as content', content: 'function test{\n\tsay hi\n}' },
		{
			name: 'block with data',
			content: 'function test {\n\tblock foo { {a:1}\n\t\tsay hi\n\t}\n}',
		},
		{
			name: 'nested braces in command (NBT)',
			content: 'function test {\n\tdata modify storage a b set value {x:1,y:{z:2}}\n}',
		},
		{
			name: 'closing brace mid-line after command',
			content:
				'function test {\n\texecute if score a b matches 1 run {\n\t\tsay hi\n\t} else run {\n\t\tsay bye\n\t}\n}',
		},
		{ name: 'line comment', content: '# a comment\nfunction test {\n}' },
		{
			name: 'block comment toggle',
			content: '###\nthis is ignored syntax\n###\nfunction test {\n}',
		},
		{ name: 'backslash continuation', content: 'function test {\n\tsay \\\n\thi there\n}' },
		{
			name: 'inline js block in brace line',
			content: 'function test {\n\tblock named/<%"with"%>/script {\n\t\tsay hi\n\t}\n}',
		},
		{
			name: 'multiline script markers',
			content: 'function test {\n\t<%%\n\temit("say hi");\n\t%%>\n}',
		},
		{
			name: 'template with args',
			content: 'template foo {\n\twith a:int b:raw {\n\t\tsay hi\n\t}\n}',
		},
		{ name: 'directory', content: 'dir test {\n\tfunction a {\n\t}\n}' },
	]
	for (const { name, content } of cases) {
		it(`tokenize ${name}`, (t) => {
			t.assert.snapshot(render(content))
		})
	}
})
