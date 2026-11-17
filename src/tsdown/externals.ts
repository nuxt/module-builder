import { isAbsolute, join, normalize, relative } from 'pathe'
import type { Rolldown } from 'tsdown'

import { rewriteAppAliases } from '../build/aliases.ts'
import { scriptExtension } from '../transpile/specifiers.ts'
import { DECLARATION_RE, isInside, NODE_MODULES_RE, probe, relativeSpecifier, SCRIPT_RE } from '../utils.ts'

/**
 * Keeps declaration imports of installed packages external, whether or not the package
 * is a dependency. Aliases that resolve into the module's own source are bundled, and
 * `#app` aliases are written as `nuxt/app`.
 */
export function externalDependencyDeclarations(): Rolldown.Plugin {
  return {
    name: 'nuxt-module-builder:external-dependency-declarations',
    resolveId: {
      order: 'pre',
      async handler(id, importer, options) {
        if (!importer || !DECLARATION_RE.test(importer) || id.startsWith('.') || id.startsWith('\0') || isAbsolute(id)) {
          return
        }
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true })
        if (resolved?.external) {
          return resolved
        }
        if (!resolved || NODE_MODULES_RE.test(resolved.id)) {
          return { id, external: true }
        }
      },
    },
    renderChunk(code, chunk) {
      if (DECLARATION_RE.test(chunk.fileName)) {
        const rewritten = rewriteAppAliases(code)
        return rewritten === code ? undefined : { code: rewritten, map: null }
      }
    },
  }
}

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
        const directory = directories.find(directory => target !== directory.outDir && isInside(directory.outDir, target))
        if (directory) {
          return { id: join(directory.outDir, distSubpath(relative(directory.outDir, target), directory)), external: true }
        }
      }

      if (!importer) {
        return
      }

      const resolved = await this.resolve(id, importer, { skipSelf: true })
      if (!resolved || resolved.external) {
        return
      }

      const file = normalize(resolved.id)
      const directory = directories.find(directory => file !== directory.srcDir && isInside(directory.srcDir, file))
      if (directory) {
        return { id: join(directory.outDir, distSubpath(relative(directory.srcDir, file), directory)), external: true }
      }
    },
    renderChunk(code, chunk, { dir }) {
      if (!dir) {
        return
      }
      const chunkFile = join(dir, chunk.fileName)
      let result = code
      for (const id of new Set([...chunk.imports, ...chunk.dynamicImports])) {
        if (!directories.some(directory => id.startsWith(`${directory.outDir}/`))) {
          continue
        }
        result = result.replaceAll(JSON.stringify(id), JSON.stringify(relativeSpecifier(chunkFile, id)))
      }
      return result === code ? undefined : { code: result, map: null }
    },
  }
}
