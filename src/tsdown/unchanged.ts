import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'pathe'
import type { Rolldown } from 'tsdown'

import { declarationTargets } from '../build/aliases.ts'
import { ANY_DECLARATION_RE } from '../utils.ts'

export interface UnchangedOutputs {
  /**
   * Removes the outputs whose content matches what the last written build emitted and that
   * still exist in `outDir`, so they are not written again. With `compareOutDir`, an output
   * that no build has written yet is removed when `outDir` already holds the same content.
   */
  prune: (bundle: Rolldown.OutputBundle, options?: { compareOutDir?: boolean }) => void
  /** Records the content of the outputs that `prune` last saw, once they are all written. */
  commit: () => void
  /** Every output of the build that `prune` last saw, pruned or not. */
  readonly bundle: Rolldown.OutputBundle
}

/** Tracks the content of each output across rebuilds, by file name. */
export function unchangedOutputs(outDir: string): UnchangedOutputs {
  let written: Map<string, string> | undefined
  let emitted = new Map<string, string>()
  let full: Rolldown.OutputBundle = {}
  return {
    get bundle() {
      return full
    },
    prune(bundle, { compareOutDir = false } = {}) {
      full = { ...bundle }
      emitted = new Map(Object.entries(bundle).map(([fileName, output]) => [fileName, contentHash(output, bundle)]))
      for (const [fileName, hash] of emitted) {
        const path = join(outDir, fileName)
        if (!existsSync(path)) {
          continue
        }
        if (written ? written.get(fileName) === hash : compareOutDir && writtenAs(bundle[fileName]!, path)) {
          Reflect.deleteProperty(bundle, fileName)
        }
      }
      // A write that fails part way leaves `outDir` matching neither build.
      written = undefined
    },
    commit() {
      written = emitted
    },
  }
}

/**
 * Whether `path` holds what `output` is written as. A chunk with a source map counts as
 * different, as the map is written from the chunk.
 */
function writtenAs(output: Rolldown.OutputChunk | Rolldown.OutputAsset, path: string) {
  if (output.type === 'chunk' && output.map) {
    return false
  }
  const code = output.type === 'chunk' ? output.code : output.source
  return readFileSync(path).equals(typeof code === 'string' ? Buffer.from(code) : Buffer.from(code))
}

/**
 * A hash of what `output` is written as. Declarations are rewritten once they are written,
 * depending on which files their relative specifiers find, so those files count too.
 */
function contentHash(output: Rolldown.OutputChunk | Rolldown.OutputAsset, bundle: Rolldown.OutputBundle) {
  const hash = createHash('sha256')
  const code = output.type === 'chunk' ? output.code : output.source
  hash.update(code).update('\0')
  if (output.type === 'chunk' && output.map) {
    hash.update(output.map.toString())
  }
  if (ANY_DECLARATION_RE.test(output.fileName)) {
    const text = typeof code === 'string' ? code : Buffer.from(code).toString('utf8')
    hash.update('\0').update(declarationTargets(output.fileName, text).filter(target => Object.hasOwn(bundle, target)).join('\0'))
  }
  return hash.digest('hex')
}
