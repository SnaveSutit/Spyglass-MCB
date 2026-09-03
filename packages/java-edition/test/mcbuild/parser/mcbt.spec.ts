import { showWhitespaceGlyph, testParser } from '@spyglassmc/core/test/utils.ts'
import { describe, it } from 'node:test'
import { mcbParser } from './utils.ts'

describe('mcbuild parser (.mcbt)', () => {
	const cases: { name: string; content: string }[] = [
		{ name: 'empty', content: '' },
		{ name: 'comment + import', content: '# templates\nimport ./other.mcbt\n' },
		{
			name: 'template with typed args',
			content: 'template with_args {\n\twith a:int b:raw {\n\t\tsay <%a%>\n\t}\n}',
		},
		{
			name: 'template with literal args',
			content:
				'template pick {\n\twith foo {\n\t\tsay foo\n\t}\n\twith bar {\n\t\tsay bar\n\t}\n}',
		},
		{
			name: 'template no args',
			content: 'template noop {\n\twith {\n\t\tsay hi\n\t}\n}',
		},
		{
			name: 'template tick/load',
			content:
				'template lifecycle {\n\tload {\n\t\tsay load\n\t}\n\ttick {\n\t\tsay tick\n\t}\n\twith {\n\t\tsay call\n\t}\n}',
		},
		{
			name: 'template block arg + embed',
			content:
				'template wrap {\n\twith content:block {\n\t\t<%%\n\t\temit.mcb(content);\n\t\t%%>\n\t}\n}',
		},
		{
			name: 'unknown arg kind',
			content: 'template bad {\n\twith a:frobnicate {\n\t\tsay hi\n\t}\n}',
		},
	]
	for (const { name, content } of cases) {
		it(`parse ${name}: '${showWhitespaceGlyph(content)}'`, (t) => {
			t.assert.snapshot(
				testParser(mcbParser(), content, { uri: 'file:///pack/src/templates.mcbt' }),
			)
		})
	}
})
