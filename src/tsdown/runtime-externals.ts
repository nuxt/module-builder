import { dirname, isAbsolute, join, normalize, relative } from 'pathe'
import type { Rolldown } from 'tsdown'

import { probe, SCRIPT_RE, scriptExtension } from '../rolldown/resolve.ts'

export interface RuntimeExternalsOptions {
  /** Absolute path of the build's output directory. */
  outDir: string
  /** The directories transpiled file by file, with their absolute source and output paths. */
  directories: Array<{ srcDir: string, outDir: string, ext: 'js' | 'mjs' }>
  /** The module's own package name, so self-referencing imports are caught. */
  packageName?: string
  /** Whether a JSX source is emitted with its JSX preserved, as `.jsx`. Defaults to always. */
  preserveJsx?: (file: string) => boolean
}

/**
 * Rewrites imports of the module's runtime tree to the absolute paths they will occupy
 * in `dist/`, and marks them external so the runtime tree is never inlined into the
 * bundled module entry. The build has to set `makeAbsoluteExternalsRelative: false`:
 * the specifiers are made relative to each chunk's own location when it is rendered.
 *
 * `this.resolve()` is used rather than pattern-matching the specifier so that
 * tsconfig path aliases resolving into `src/runtime/` are handled too.
 */
export function runtimeExternals({ outDir, directories, packageName, preserveJsx = () => true }: RuntimeExternalsOptions): Rolldown.Plugin {
  const selfPrefix = packageName ? `${packageName}/` : undefined
  const distSubpath = (subpath: string, { srcDir, ext }: { srcDir: string, ext: string }) => {
    const source = probe(join(srcDir, subpath))
    if (source && SCRIPT_RE.test(source)) {
      return relative(srcDir, source).replace(SCRIPT_RE, scriptExtension(source, `.${ext}`, preserveJsx(source)))
    }
    if (source || subpath.endsWith('.vue')) {
      return subpath
    }
    return `${subpath.replace(SCRIPT_RE, '')}.${ext}`
  }

  return {
    name: 'nuxt-module-builder:runtime-externals',
    async resolveId(id, importer) {
      if (selfPrefix && id.startsWith(selfPrefix)) {
        const target = join(outDir, id.slice(selfPrefix.length))
        for (const directory of directories) {
          const subpath = relative(directory.outDir, target)
          if (subpath && !subpath.startsWith('..') && !isAbsolute(subpath)) {
            return { id: join(directory.outDir, distSubpath(subpath, directory)), external: true }
          }
        }
      }

      if (!importer) {
        return
      }

      const resolved = await this.resolve(id, importer, { skipSelf: true })
      if (!resolved || resolved.external) {
        return
      }

      for (const directory of directories) {
        const subpath = relative(directory.srcDir, normalize(resolved.id))
        if (subpath && !subpath.startsWith('..') && !isAbsolute(subpath)) {
          return { id: join(directory.outDir, distSubpath(subpath, directory)), external: true }
        }
      }
    },
    renderChunk(code, chunk, { dir }) {
      if (!dir) {
        return
      }
      const chunkDir = dirname(join(dir, chunk.fileName))
      let result = code
      for (const id of new Set([...chunk.imports, ...chunk.dynamicImports])) {
        if (!directories.some(directory => id.startsWith(`${directory.outDir}/`))) {
          continue
        }
        const specifier = relative(chunkDir, id)
        result = result.replaceAll(JSON.stringify(id), JSON.stringify(specifier.startsWith('.') ? specifier : `./${specifier}`))
      }
      return result === code ? undefined : { code: result, map: null }
    },
  }
}
