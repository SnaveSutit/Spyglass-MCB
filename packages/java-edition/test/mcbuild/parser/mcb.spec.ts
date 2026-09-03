import { showWhitespaceGlyph, testParser } from '@spyglassmc/core/test/utils.ts'
import { describe, it } from 'node:test'
import { mcbParser } from './utils.ts'

describe('mcbuild parser (.mcb)', () => {
	const cases: { name: string; content: string }[] = [
		{ name: 'empty', content: '' },
		{ name: 'comment', content: '# a top level comment\n' },
		{ name: 'function', content: 'function test {\n\tsay hi\n}' },
		{ name: 'function append to tag', content: 'function on_load minecraft:load {\n\tsay hi\n}' },
		{ name: 'directory', content: 'dir test {\n\tfunction inner {\n\t\tsay hi\n\t}\n}' },
		{ name: 'clock', content: 'clock test 1s {\n\tsay hi\n}' },
		{ name: 'import', content: 'import ./templates.mcbt\n' },
		{
			name: 'nested blocks',
			content:
				'function test {\n\tblock foo {\n\t\tsay 1\n\t\tblock {\n\t\t\tsay 2\n\t\t}\n\t}\n}',
		},
		{
			name: 'block with data',
			content: 'function test {\n\tblock foo { {a:1}\n\t\tsay hi\n\t}\n}',
		},
		{
			name: 'execute block with else',
			content:
				'function test {\n\texecute if score a b matches 1 run {\n\t\tsay 1\n\t} else run {\n\t\tsay 2\n\t}\n}',
		},
		{
			name: 'execute run inline',
			content: 'function test {\n\texecute run say hi\n}',
		},
		{
			name: 'schedule forms',
			content:
				'function test {\n\tschedule 1t append {\n\t\tsay hi\n\t}\n\tschedule function ./demo 1t replace\n\tschedule clear *demo\n}',
		},
		{ name: 'return run', content: 'function test {\n\treturn run say hi\n}' },
		{
			name: 'macro line',
			content: 'function test {\n\t$say hi $(name)\n\t$function ./demo\n}',
		},
		{
			name: 'compile-time if/else',
			content:
				'function test {\n\tIF (x === 0) {\n\t\tsay zero\n\t} ELSE IF (x === 1) {\n\t\tsay one\n\t} ELSE {\n\t\tsay other\n\t}\n}',
		},
		{
			name: 'compile-time loop',
			content:
				'dir gen {\n\tfunction loop {\n\t\tREPEAT(1,3) as i {\n\t\t\tsay <%i%>\n\t\t}\n\t}\n}',
		},
		{
			name: 'multiline script',
			content: 'function test {\n\t<%%\n\temit("say hi");\n\t%%>\n}',
		},
		{ name: 'eq statement', content: 'function test {\n\teq a b = c d + 7 * (e f + 2)\n}' },
		{
			name: 'inline js in command',
			content: 'function test {\n\tsay value is <%1 + 2%>\n}',
		},
		{
			name: 'template block-argument call',
			content: 'function test {\n\tmy_template 3.4 {\n\t\tsay body\n\t}\n}',
		},
		{
			name: 'tag file',
			content: 'tag function test replace {\n\tminecraft:load\n\t#./other\n\t*abs/fn\n}',
		},
		{
			name: 'loot table file',
			content: 'loot_table my_loot {\n\t"type": "minecraft:block"\n}',
		},
	]
	for (const { name, content } of cases) {
		it(`parse ${name}: '${showWhitespaceGlyph(content)}'`, (t) => {
			t.assert.snapshot(testParser(mcbParser(), content, { uri: 'file:///pack/data/test.mcb' }))
		})
	}
})
