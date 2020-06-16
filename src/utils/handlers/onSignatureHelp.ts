import { SignatureInformation, Position } from 'vscode-languageserver'
import { VanillaData } from '../../data/VanillaData'
import { LineParser } from '../../parsers/LineParser'
import { CacheFile } from '../../types/ClientCache'
import { CommandTree } from '../../types/CommandTree'
import { FunctionInfo } from '../../types/FunctionInfo'
import { constructContext } from '../../types/ParsingContext'
import { StringReader } from '../StringReader'
import { DocNode } from '../../types'
import { NodeRange } from '../../nodes'

export async function onSignatureHelp({ offset, node, info, cacheFile, commandTree, vanillaData }: { offset: number, node: DocNode, info: FunctionInfo, cacheFile: CacheFile, commandTree?: CommandTree, vanillaData?: VanillaData }) {
    try {
        const signatures: SignatureInformation[] = []

        const parser = new LineParser(false, 'line')
        const reader = new StringReader(
            info.content.getText(),
            node[NodeRange].start,
            node[NodeRange].end
        )
        const { data: { hint: { fix, options } } } = parser.parse(reader, constructContext({
            cursor: offset,
            cache: cacheFile.cache,
            config: info.config,
            content: info.content
        }, commandTree, vanillaData))

        const fixLabel = fix.join(' ')

        // eslint-disable-next-line prefer-const
        for (let [current, nextOptions] of options) {
            if (nextOptions.length === 0) {
                nextOptions = ['']
            }
            for (const nextOption of nextOptions) {
                const fixLabelStart = 0
                const fixLabelEnd = fixLabelStart + fixLabel.length

                const currentStart = fixLabelEnd + 1 // The 1 is for the space between `fixLabel` and `current`
                const currentEnd = currentStart + current.length

                const nextOptionStart = currentEnd + 1 // The 1 is for the space between `current` and `nextOption`
                const nextOptionEnd = nextOptionStart + nextOption.length

                signatures.push({
                    label: `${fixLabel} ${current} ${nextOption}`,
                    parameters: [
                        { label: [fixLabelStart, fixLabelEnd] },
                        { label: [currentStart, currentEnd] },
                        { label: [nextOptionStart, nextOptionEnd] }
                    ]
                })
            }
        }

        return { signatures, activeParameter: 1, activeSignature: signatures.length - 1 }
    } catch (e) {
        console.error(e)
    }
    return null
}
