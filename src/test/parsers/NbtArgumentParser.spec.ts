import assert = require('power-assert')
import ArgumentParserManager from '../../parsers/ArgumentParserManager'
import NbtArgumentParser from '../../parsers/NbtArgumentParser'
import ParsingError from '../../types/ParsingError'
import StringReader from '../../utils/StringReader'
import { constructConfig } from '../../types/Config'
import ParsingContext, { constructContext } from '../../types/ParsingContext'
import { CompletionItemKind, DiagnosticSeverity } from 'vscode-languageserver'
import { describe, it } from 'mocha'
import NbtStringNode from '../../types/nodes/nbt/NbtStringNode'
import NbtByteNode from '../../types/nodes/nbt/NbtByteNode'
import NbtShortNode from '../../types/nodes/nbt/NbtShortNode'
import NbtIntNode from '../../types/nodes/nbt/NbtIntNode'
import { NodeRange, NodeDescription } from '../../types/nodes/ArgumentNode'
import NbtLongNode from '../../types/nodes/nbt/NbtLongNode'
import NbtFloatNode from '../../types/nodes/nbt/NbtFloatNode'
import NbtDoubleNode from '../../types/nodes/nbt/NbtDoubleNode'
import NbtCompoundNode from '../../types/nodes/map/NbtCompoundNode'
import { TestRegistry, TestNbtdoc } from '../utils/NbtdocHelper.spec'
import NbtCompoundKeyNode from '../../types/nodes/map/NbtCompoundKeyNode'
import { Keys } from '../../types/nodes/map/MapNode'
import NbtListNode, { ChildNbtNodeType } from '../../types/nodes/nbt/NbtListNode'
import NbtByteArrayNode from '../../types/nodes/nbt/NbtByteArrayNode'
import NbtIntArrayNode from '../../types/nodes/nbt/NbtIntArrayNode'
import NbtLongArrayNode from '../../types/nodes/nbt/NbtLongArrayNode'

describe('NbtArgumentParser Tests', () => {
    describe('getExamples() Tests', () => {
        it('Should return examples respectfully', () => {
            const parser = new NbtArgumentParser(['Byte', 'Compound', 'LongArray'], 'minecraft:block')
            const examples = parser.getExamples()
            assert.deepStrictEqual(examples, ['0b', '{}', '{foo: bar}', '[L; 0L]'])
        })
    })

    const parsers = new ArgumentParserManager()
    let ctx: ParsingContext
    before(async () => {
        ctx = await constructContext({ parsers, registry: TestRegistry, nbt: TestNbtdoc })
    })
    describe('parse() Tests', () => {
        it('Should parse quoted string tags', () => {
            const parser = new NbtArgumentParser('String', 'minecraft:block')
            const reader = new StringReader('"bar\\""}')
            const expected = new NbtStringNode(null, 'bar"', '"bar\\""', [1, 2, 3, 5])
            expected[NodeRange] = { start: 0, end: 7 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse unquoted string tags', () => {
            const parser = new NbtArgumentParser('String', 'minecraft:block')
            const reader = new StringReader('bar')
            const expected = new NbtStringNode(null, 'bar', 'bar', [0, 1, 2])
            expected[NodeRange] = { start: 0, end: 3 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse byte tags', () => {
            const parser = new NbtArgumentParser('Byte', 'minecraft:block')
            const reader = new StringReader('5b')
            const expected = new NbtByteNode(null, 5, '5')
            expected[NodeRange] = { start: 0, end: 2 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse true', () => {
            const parser = new NbtArgumentParser('Byte', 'minecraft:block')
            const reader = new StringReader('true')
            const expected = new NbtByteNode(null, 1, 'true')
            expected[NodeRange] = { start: 0, end: 4 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse false', () => {
            const parser = new NbtArgumentParser('Byte', 'minecraft:block')
            const reader = new StringReader('false')
            const expected = new NbtByteNode(null, 0, 'false')
            expected[NodeRange] = { start: 0, end: 5 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should treat overflow byte tags as string tags', () => {
            const parser = new NbtArgumentParser(['Byte', 'String'], 'minecraft:block')
            const reader = new StringReader('1234b')
            const expected = new NbtStringNode(null, '1234b', '1234b', [0, 1, 2, 3, 4])
            expected[NodeRange] = { start: 0, end: 5 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [new ParsingError(
                { start: 0, end: 5 },
                'Expected a number between -128 and 127 but got 1234',
                undefined, DiagnosticSeverity.Warning
            )])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse short tags', () => {
            const parser = new NbtArgumentParser('Short', 'minecraft:block')
            const reader = new StringReader('5s')
            const expected = new NbtShortNode(null, 5, '5')
            expected[NodeRange] = { start: 0, end: 2 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should treat overflow short tags as string tags', () => {
            const parser = new NbtArgumentParser(['Short', 'String'], 'minecraft:block')
            const reader = new StringReader('123456s')
            const expected = new NbtStringNode(null, '123456s', '123456s', [0, 1, 2, 3, 4, 5, 6])
            expected[NodeRange] = { start: 0, end: 7 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [new ParsingError(
                { start: 0, end: 7 },
                'Expected a number between -32,768 and 32,767 but got 123456',
                undefined, DiagnosticSeverity.Warning
            )])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse int tags', () => {
            const parser = new NbtArgumentParser('Int', 'minecraft:block')
            const reader = new StringReader('12345')
            const expected = new NbtIntNode(null, 12345, '12345')
            expected[NodeRange] = { start: 0, end: 5 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should treat overflow int tags as string tags', () => {
            const parser = new NbtArgumentParser(['Int', 'String'], 'minecraft:block')
            const reader = new StringReader('12345678901')
            const expected = new NbtStringNode(null, '12345678901', '12345678901', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
            expected[NodeRange] = { start: 0, end: 11 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [new ParsingError(
                { start: 0, end: 11 },
                'Expected a number between -2,147,483,648 and 2,147,483,647 but got 12345678901',
                undefined, DiagnosticSeverity.Warning
            )])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse long tags', () => {
            const parser = new NbtArgumentParser('Long', 'minecraft:block')
            const reader = new StringReader('1234567890L')
            const expected = new NbtLongNode(null, BigInt(1234567890), '1234567890')
            expected[NodeRange] = { start: 0, end: 11 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should treat overflow long tags as string tags', () => {
            const parser = new NbtArgumentParser(['Long', 'String'], 'minecraft:block')
            const reader = new StringReader('12345678901234567890L')
            const expected = new NbtStringNode(null, '12345678901234567890L', '12345678901234567890L', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
            expected[NodeRange] = { start: 0, end: 21 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [new ParsingError(
                { start: 0, end: 21 },
                'Expected a number between -9,223,372,036,854,775,808 and 9,223,372,036,854,775,807 but got 12345678901234567890',
                undefined, DiagnosticSeverity.Warning
            )])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse float tags', () => {
            const parser = new NbtArgumentParser('Float', 'minecraft:block')
            const reader = new StringReader('12.00f')
            const expected = new NbtFloatNode(null, 12, '12.00')
            expected[NodeRange] = { start: 0, end: 6 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse double tags', () => {
            const parser = new NbtArgumentParser('Double', 'minecraft:block')
            const reader = new StringReader('12.00d')
            const expected = new NbtDoubleNode(null, 12, '12.00')
            expected[NodeRange] = { start: 0, end: 6 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        it('Should parse implicit double tags', () => {
            const parser = new NbtArgumentParser('Double', 'minecraft:block')
            const reader = new StringReader('12.00')
            const expected = new NbtDoubleNode(null, 12, '12.00')
            expected[NodeRange] = { start: 0, end: 5 }

            const { data, errors, cache, completions } = parser.parse(reader, ctx)

            assert.deepStrictEqual(data, expected)
            assert.deepStrictEqual(errors, [])
            assert.deepStrictEqual(cache, {})
            assert.deepStrictEqual(completions, [])
        })
        describe('Compound Tests', () => {
            it('Should provide completions for compound curly brackets', () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('')
                const cursor = 0

                const { completions } = parser.parse(reader, { ...ctx, cursor })

                assert.deepStrictEqual(completions, [{ label: '{}' }])
            })
            it('Should parse empty compound tags', async () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{}')
                const expected = new NbtCompoundNode(null)
                expected[NodeRange] = { start: 0, end: 2 }

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should provide completions for compound keys', () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{}')
                const cursor = 1

                const { completions } = parser.parse(reader, { ...ctx, cursor })

                assert.deepStrictEqual(completions, [{
                    label: 'foo', insertText: 'foo',
                    kind: CompletionItemKind.Property,
                    detail: 'Type: Boolean',
                    documentation: 'The only field of this compound'
                }])
            })
            it('Should provide completions for quoted compound keys', () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{""}')
                const cursor = 2

                const { completions } = parser.parse(reader, { ...ctx, cursor })

                assert.deepStrictEqual(completions, [{
                    label: 'foo', insertText: 'foo',
                    kind: CompletionItemKind.Property,
                    detail: 'Type: Boolean',
                    documentation: 'The only field of this compound'
                }])
            })
            it('Should report errors for empty keys and values', () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{:}')

                const { errors } = parser.parse(reader, ctx)

                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 1, end: 2 },
                    'Expected a key but got nothing'
                ), new ParsingError(
                    { start: 2, end: 3 },
                    'Expected a tag but got nothing'
                )])
            })
            it('Should report errors for keys that do not follow the convention', () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{foo: 1b}')
                const config = constructConfig({
                    lint: {
                        nameOfNbtCompoundTagKeys: ['warning', 'PascalCase']
                    }
                })

                const { errors } = parser.parse(reader, { ...ctx, config })

                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 1, end: 4 },
                    "Invalid key ‘foo’ which doesn't follow ‘PascalCase’ convention",
                    undefined, DiagnosticSeverity.Warning
                )])
            })
            it('Should parse correctly filled compound tags', async () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{foo: true}')
                const expected = new NbtCompoundNode(null)
                expected[NodeRange] = { start: 0, end: 11 }
                const expectedChild = new NbtByteNode(expected, 1, 'true')
                expectedChild[NodeRange] = { start: 6, end: 10 }
                expected.foo = expectedChild
                const expectedKey = new NbtCompoundKeyNode(expected, 'foo', 'foo', [1, 2, 3])
                expectedKey[NodeRange] = { start: 1, end: 4 }
                expectedKey[NodeDescription] = 'Type: Boolean\n* * * * * *\nThe only field of this compound'
                expected[Keys].foo = expectedKey

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should report errors for duplicated keys', () => {
                const parser = new NbtArgumentParser('Compound', 'minecraft:block', 'minecraft:one_boolean_field')
                const reader = new StringReader('{foo: 1b, foo: 1b}')

                const { errors } = parser.parse(reader, { ...ctx })

                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 10, end: 13 },
                    "Duplicate key ‘foo’",
                    undefined, DiagnosticSeverity.Warning
                )])
            })
        })
        describe('List and Array Tests', () => {
            it('Should parse empty byte array tags', async () => {
                const parser = new NbtArgumentParser('ByteArray', 'minecraft:block')
                const reader = new StringReader('[B;]')
                const expected = new NbtByteArrayNode(null)
                expected[NodeRange] = { start: 0, end: 4 }

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse filled byte array tags', async () => {
                const parser = new NbtArgumentParser('ByteArray', 'minecraft:block')
                const reader = new StringReader('[B; 1b]')
                const expected = new NbtByteArrayNode(null)
                expected[NodeRange] = { start: 0, end: 7 }
                const expectedChild = new NbtByteNode(null, 1, '1')
                expectedChild[NodeRange] = { start: 4, end: 6 }
                expected.push(expectedChild)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should report errors for wrong children in byte array tags', async () => {
                const parser = new NbtArgumentParser('ByteArray', 'minecraft:block')
                const reader = new StringReader('[B; 1s]')
                const expected = new NbtByteArrayNode(null)
                expected[NodeRange] = { start: 0, end: 7 }
                const expectedChild = new NbtShortNode(null, 1, '1')
                expectedChild[NodeRange] = { start: 4, end: 6 }
                expected.push(expectedChild as unknown as NbtByteNode)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 4, end: 6 },
                    'Expected a byte tag but got a short tag'
                )])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse empty int array tags', async () => {
                const parser = new NbtArgumentParser('IntArray', 'minecraft:block')
                const reader = new StringReader('[I;]')
                const expected = new NbtIntArrayNode(null)
                expected[NodeRange] = { start: 0, end: 4 }

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse filled int array tags', async () => {
                const parser = new NbtArgumentParser('IntArray', 'minecraft:block')
                const reader = new StringReader('[I; 1]')
                const expected = new NbtIntArrayNode(null)
                expected[NodeRange] = { start: 0, end: 6 }
                const expectedChild = new NbtIntNode(null, 1, '1')
                expectedChild[NodeRange] = { start: 4, end: 5 }
                expected.push(expectedChild)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should report errors for wrong children in int array tags', async () => {
                const parser = new NbtArgumentParser('IntArray', 'minecraft:block')
                const reader = new StringReader('[I; 1s]')
                const expected = new NbtIntArrayNode(null)
                expected[NodeRange] = { start: 0, end: 7 }
                const expectedChild = new NbtShortNode(null, 1, '1')
                expectedChild[NodeRange] = { start: 4, end: 6 }
                expected.push(expectedChild as unknown as NbtIntNode)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 4, end: 6 },
                    'Expected an int tag but got a short tag'
                )])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse empty long array tags', async () => {
                const parser = new NbtArgumentParser('LongArray', 'minecraft:block')
                const reader = new StringReader('[L;]')
                const expected = new NbtLongArrayNode(null)
                expected[NodeRange] = { start: 0, end: 4 }

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse filled long array tags', async () => {
                const parser = new NbtArgumentParser('LongArray', 'minecraft:block')
                const reader = new StringReader('[L; 1L]')
                const expected = new NbtLongArrayNode(null)
                expected[NodeRange] = { start: 0, end: 7 }
                const expectedChild = new NbtLongNode(null, BigInt(1), '1')
                expectedChild[NodeRange] = { start: 4, end: 6 }
                expected.push(expectedChild)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should report errors for wrong children in byte array tags', async () => {
                const parser = new NbtArgumentParser('LongArray', 'minecraft:block')
                const reader = new StringReader('[L; 1s]')
                const expected = new NbtLongArrayNode(null)
                expected[NodeRange] = { start: 0, end: 7 }
                const expectedChild = new NbtShortNode(null, 1, '1')
                expectedChild[NodeRange] = { start: 4, end: 6 }
                expected.push(expectedChild as unknown as NbtLongNode)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 4, end: 6 },
                    'Expected a long tag but got a short tag'
                )])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should report errors for wrong array types', async () => {
                const parser = new NbtArgumentParser(['ByteArray', 'IntArray', 'LongArray'], 'minecraft:block')
                const reader = new StringReader('[X; 1x]')
                const expected = new NbtByteArrayNode(null)
                expected[NodeRange] = { start: 0, end: 2 }

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 1, end: 2 },
                    'Invalid array type ‘X’. Should be one of ‘B’, ‘I’, and ‘L’'
                )])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse empty list tags', async () => {
                const parser = new NbtArgumentParser('List', 'minecraft:block')
                const reader = new StringReader('[]')
                const expected = new NbtListNode(null)
                expected[NodeRange] = { start: 0, end: 2 }

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should parse filled list tags', async () => {
                const parser = new NbtArgumentParser('List', 'minecraft:block')
                const reader = new StringReader('[1L]')
                const expected = new NbtListNode(null)
                expected[NodeRange] = { start: 0, end: 4 }
                expected[ChildNbtNodeType] = 'Long'
                const expectedChild = new NbtLongNode(null, BigInt(1), '1')
                expectedChild[NodeRange] = { start: 1, end: 3 }
                expected.push(expectedChild)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
            it('Should report errors for wrong children type in list tags', async () => {
                const parser = new NbtArgumentParser('List', 'minecraft:block')
                const reader = new StringReader('[1L, 1s]')
                const expected = new NbtListNode(null)
                expected[NodeRange] = { start: 0, end: 8 }
                expected[ChildNbtNodeType] = 'Long'
                const expectedChild1 = new NbtLongNode(null, BigInt(1), '1')
                expectedChild1[NodeRange] = { start: 1, end: 3 }
                expected.push(expectedChild1)
                const expectedChild2 = new NbtShortNode(null, 1, '1')
                expectedChild2[NodeRange] = { start: 5, end: 7 }
                expected.push(expectedChild2)

                const { data, errors, cache, completions } = parser.parse(reader, ctx)

                assert.deepStrictEqual(data, expected)
                assert.deepStrictEqual(errors, [new ParsingError(
                    { start: 5, end: 7 },
                    'Expected a long tag but got a short tag'
                )])
                assert.deepStrictEqual(cache, {})
                assert.deepStrictEqual(completions, [])
            })
        })
    })
})
