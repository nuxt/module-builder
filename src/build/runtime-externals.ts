import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative } from 'pathe'
import type { Rolldown } from 'tsdown'

const CODE_EXTENSION_RE = /\.[cm]?[tj]sx?$/
const CODE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

export interface RuntimeExternalsOptions {
  /** Absolute path of the build's output directory. */
  outDir: string
  /** The directories transpiled file by file, with their absolute source and output paths. */
  directories: Array<{ srcDir: string, outDir: string, ext: 'js' | 'mjs' }>
  /** The module's own package name, so self-referencing imports are caught. */
  packageName?: string
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
export function runtimeExternals({ outDir, directories, packageName }: RuntimeExternalsOptions): Rolldown.Plugin {
  const selfPrefix = packageName ? `${packageName}/` : undefined

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

function distSubpath(subpath: string, { srcDir, ext }: { srcDir: string, ext: string }) {
  if (CODE_EXTENSION_RE.test(subpath)) {
    return subpath.replace(CODE_EXTENSION_RE, `.${ext}`)
  }
  const source = join(srcDir, subpath)
  if (subpath.endsWith('.vue') || isFile(source)) {
    return subpath
  }
  if (!CODE_EXTENSIONS.some(extension => isFile(source + extension)) && CODE_EXTENSIONS.some(extension => isFile(join(source, `index${extension}`)))) {
    return `${subpath}/index.${ext}`
  }
  return `${subpath}.${ext}`
}

function isFile(path: string) {
  return existsSync(path) && statSync(path).isFile()
}
