import { testParser } from '@spyglassmc/core/test/utils.ts'
import { describe, it } from 'node:test'
import { mcbParser } from './utils.ts'

/** Cases from mc-build's `tests/eq/source/main.mcb`. */
describe('mcbuild parser (eq)', () => {
	const exprs: string[] = [
		'a b = 1',
		'a b = a d + 7 * (2 * c e + 3 * f g)',
		'constTarget points = 42',
		'sumTarget score += h i + 4 - 5',
		'selfTarget main = selfTarget main + otherTarget alt * 2',
		'negateTarget main = -(negSource value)',
		'copyTarget data = copySource data',
		'decrementTarget counter -= 3',
		'divideTarget stat /= divisor stat',
		'moduloTarget stat %= 5',
		'selectorTarget stat += @s ticker',
		'divisionExprTarget stat = h i / divisor stat',
		'moduloBinaryTarget stat = h i % divisor stat',
		'#a.b c = #d.e f + 2',
		// error cases
		'target obj = 1.5',
		'target obj = missingObjective',
		'target obj = (1 + 2',
	]
	for (const expr of exprs) {
		it(`parse 'eq ${expr}'`, (t) => {
			const { node, errors } = testParser(
				mcbParser(),
				`function t {\n\teq ${expr}\n}`,
				{ uri: 'file:///pack/data/test.mcb' },
			)
			t.assert.snapshot({ errors, node })
		})
	}
})
