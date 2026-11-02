import { CompleterContext, Logger, MetaRegistry, Range } from '@spyglassmc/core'
import { getNodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { importCompletion } from '@spyglassmc/java-edition/lib/mcbuild/importCompletion.js'
import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import type fsp from 'node:fs/promises'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

const MainUri = 'file:///pack/src/ns/main.mcb'

const Disk = {
	'/pack/src/ns/main.mcb': '',
	'/pack/src/ns/sibling.mcbt': '',
	'/pack/src/ns/helpers.js': '',
	'/pack/src/ns/data.json': '{}',
	'/pack/src/ns/other.mcb': '',
	'/pack/src/ns/notes.txt': '',
	'/pack/src/ns/.hidden.mcbt': '',
	'/pack/src/ns/node_modules/x.js': '',
	'/pack/src/lib/t.mcbt': '',
	'/pack/src/tools/root.mcbt': '',
	'/pack/outside.mcbt': '',
}

/** Completes at the `|` in `content`, as the file at `uri`, against `Disk`. */
async function completeAt(content: string, uri = MainUri) {
	const offset = content.indexOf('|')
	assert.notEqual(offset, -1, 'content must contain a `|` cursor marker')
	const text = content.slice(0, offset) + content.slice(offset + 1)
	const { fs } = memfs(Disk, '/')
	const externals = getNodeJsExternals({
		cacheRoot: 'file:///cache/',
		logger: Logger.noop(),
		nodeFsp: fs.promises as unknown as typeof fsp,
	})
	const project = mockProjectData({ meta: new MetaRegistry(), externals, roots: ['file:///'] })
	const doc = TextDocument.create(uri, 'mc-build', 0, text)
	const node = { type: 'file', range: Range.create(0, text.length), children: [] }
	return importCompletion(node, CompleterContext.create(project, { doc, offset }))
}

async function labels(content: string, uri?: string) {
	return (await completeAt(content, uri)).map((i) => i.label).sort()
}

describe('mcbuild import completion', () => {
	it('starts with the path prefixes', async () => {
		assert.deepEqual(await labels('import |'), ['../', './', '/'])
		assert.deepEqual(await labels('import .|'), ['../', './', '/'])
	})

	it('lists importable files and folders in the folder being typed', async () => {
		assert.deepEqual(await labels('import ./|'), ['data.json', 'helpers.js', 'sibling.mcbt'])
		assert.deepEqual(await labels('import ../|'), ['../', 'lib/', 'ns/', 'tools/'])
		assert.deepEqual(await labels('import ../lib/|'), ['t.mcbt'])
	})

	it('treats a bare folder like a relative one', async () => {
		assert.deepEqual(await labels('import |', 'file:///pack/src/main.mcb'), ['../', './', '/'])
		assert.deepEqual(await labels('import lib/|', 'file:///pack/src/main.mcb'), ['t.mcbt'])
	})

	it('lists `/` from `src/`, like mc-build', async () => {
		assert.deepEqual(await labels('import /|'), ['lib/', 'ns/', 'tools/'])
		assert.deepEqual(await labels('import /tools/|'), ['root.mcbt'])
	})

	it('replaces only the segment after the last slash', async () => {
		const content = 'import ../li|'
		const items = await completeAt(content)
		const lib = items.find((i) => i.label === 'lib/')
		assert.ok(lib)
		assert.deepEqual(lib.range, Range.create(content.indexOf('li'), content.indexOf('|')))
		assert.equal(lib.retrigger, true)
	})

	it('skips files the file already imports, and itself', async () => {
		assert.deepEqual(
			await labels('import ./sibling.mcbt\nimport ./|'),
			['data.json', 'helpers.js'],
		)
		assert.deepEqual(await labels('import ./|', 'file:///pack/src/ns/sibling.mcbt'), [
			'data.json',
			'helpers.js',
		])
	})

	it('offers nothing for a missing folder or outside an import', async () => {
		assert.deepEqual(await labels('import ./nope/|'), [])
		assert.deepEqual(await labels('function t {\n\tsay ./|\n}'), [])
		assert.deepEqual(await labels('import ./|', 'file:///pack/src/ns/x.mcfunction'), [])
	})
})
