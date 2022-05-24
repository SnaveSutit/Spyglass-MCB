import { Uri } from '../common/index.js'
import type { UnlinkedSymbolTable } from '../symbol/index.js'
import { SymbolTable } from '../symbol/index.js'
import type { RootUriString } from './fileUtil.js'
import { fileUtil } from './fileUtil.js'
import type { Project } from './Project.js'

/**
 * The format version of the cache. Should be increased when any changes that
 * could invalidate the cache are introduced to the Spyglass codebase.
 */
export const LatestCacheVersion = 1

/**
 * Checksums of cached files or roots.
 */
interface Checksums {
	files: Record<string, string>,
	roots: Record<RootUriString, string>,
	symbolRegistrars: Record<string, string>,
}
namespace Checksums {
	export function create(): Checksums {
		return {
			files: {},
			roots: {},
			symbolRegistrars: {},
		}
	}
}

/**
 * Format of cache JSON files.
 */
interface CacheFile {
	checksums: Checksums,
	projectRoot: string,
	symbols: UnlinkedSymbolTable,
	/**
	 * Format version of the cache. The cache should be invalidated if this number
	 * doesn't match {@link LatestCacheVersion}.
	 */
	version: number
}

interface LoadResult {
	symbols: SymbolTable,
}

interface ValidateResult {
	addedFiles: string[],
	changedFiles: string[],
	removedFiles: string[],
	unchangedFiles: string[],
}

export class CacheService {
	checksums = Checksums.create()
	#hasValidatedFiles = false

	/**
	 * @param cacheRoot File path to the directory where cache files by Spyglass should be stored.
	 * @param project 
	 */
	constructor(
		private readonly cacheRoot: RootUriString,
		private readonly project: Project,
	) {
		this.project.on('documentUpdated', async ({ doc }) => {
			if (!this.#hasValidatedFiles) {
				return
			}
			try {
				// TODO: Don't update this for every single change.
				this.checksums.files[doc.uri] = await this.project.externals.crypto.getSha1(doc.getText())
			} catch (e) {
				if (!this.project.externals.error.isKind(e, 'EISDIR')) {
					this.project.logger.error(`[CacheService#hash-file] ${doc.uri}`)
				}
			}
		})
		this.project.on('rootsUpdated', async ({ roots }) => {
			if (!this.#hasValidatedFiles) {
				return
			}
			for (const root of roots) {
				try {
					this.checksums.roots[root] = await this.project.fs.hash(root)
				} catch (e) {
					if (!this.project.externals.error.isKind(e, 'EISDIR')) {
						this.project.logger.error(`[CacheService#hash-root] ${root}`)
					}
				}
			}
		})
		this.project.on('symbolRegistrarExecuted', ({ id, checksum }) => {
			if (checksum !== undefined) {
				this.checksums.symbolRegistrars[id] = checksum
			}
		})
	}

	#cacheFilePath: string | undefined
	/**
	 * @throws
	 * 
	 * @returns `${cacheRoot}symbols/${sha1(projectRoot)}.json`
	 */
	private async getCacheFileUri(): Promise<string> {
		return this.#cacheFilePath ??= new Uri(`symbols/${await this.project.externals.crypto.getSha1(this.project.projectRoot)}.json.gz`, this.cacheRoot).toString()
	}

	async load(): Promise<LoadResult> {
		const __profiler = this.project.profilers.get('cache#load')
		const ans: LoadResult = { symbols: {} }
		let filePath: string | undefined
		try {
			filePath = await this.getCacheFileUri()
			this.project.logger.info(`[CacheService#load] symbolCachePath = “${filePath}”`)
			const cache = await fileUtil.readGzippedJson(this.project.externals, filePath) as CacheFile
			__profiler.task('Read File')
			if (cache.version === LatestCacheVersion) {
				this.checksums = cache.checksums
				ans.symbols = SymbolTable.link(cache.symbols)
				__profiler.task('Link Symbols')
			} else {
				this.project.logger.info(`[CacheService#load] Unsupported cache format ${cache.version}; expected ${LatestCacheVersion}`)
			}
		} catch (e) {
			if (!this.project.externals.error.isKind(e, 'ENOENT')) {
				this.project.logger.error('[CacheService#load] ', e)
			}
		}
		__profiler.finalize()
		return ans
	}

	async validate(): Promise<ValidateResult> {
		const ans: ValidateResult = {
			addedFiles: [],
			changedFiles: [],
			removedFiles: [],
			unchangedFiles: [],
		}

		const unchangedRoots: string[] = []
		for (const [uri, checksum] of Object.entries(this.checksums.roots)) {
			try {
				const hash = await this.project.fs.hash(uri)
				if (hash === checksum) {
					unchangedRoots.push(uri)
				}
			} catch (e) {
				if (!this.project.externals.error.isKind(e, 'EISDIR')) {
					this.project.logger.error(`[CacheService#hash-file] ${uri}`)
				}
				// Failed calculating hash. Assume the root has changed.
			}
		}

		for (const [uri, checksum] of Object.entries(this.checksums.files)) {
			if (unchangedRoots.some(root => uri.startsWith(root))) {
				ans.unchangedFiles.push(uri)
				continue
			}

			try {
				const hash = await this.project.fs.hash(uri)
				if (hash === checksum) {
					ans.unchangedFiles.push(uri)
				} else {
					ans.changedFiles.push(uri)
				}
			} catch (e) {
				if (this.project.externals.error.isKind(e, 'ENOENT') || this.project.externals.error.isKind(e, 'EISDIR')) {
					ans.removedFiles.push(uri)
				} else {
					this.project.logger.error(`[CacheService#validate] ${uri}`, e)
					// Assume the file has changed.
					ans.changedFiles.push(uri)
				}
			}
		}

		for (const uri of this.project.getTrackedFiles()) {
			if (!(uri in this.checksums.files)) {
				ans.addedFiles.push(uri)
			}
		}

		this.#hasValidatedFiles = true

		return ans
	}

	/**
	 * @returns If the cache file was saved successfully.
	 */
	async save(): Promise<boolean> {
		const __profiler = this.project.profilers.get('cache#save')
		let filePath: string | undefined
		try {
			filePath = await this.getCacheFileUri()
			const cache: CacheFile = {
				checksums: this.checksums,
				projectRoot: this.project.projectRoot,
				symbols: SymbolTable.unlink(this.project.symbols.global),
				version: LatestCacheVersion,
			}
			__profiler.task('Unlink Symbols')

			await fileUtil.writeGzippedJson(this.project.externals, filePath, cache)
			__profiler.task('Write File').finalize()

			return true
		} catch (e) {
			this.project.logger.error(`[CacheService#save] path = “${filePath}”`, e)
		}
		return false
	}

	reset(): void {
		this.checksums = Checksums.create()
	}
}
