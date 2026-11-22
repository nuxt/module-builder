import { existsSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'pathe'
import type { Rolldown } from 'tsdown'

import { rewriteAppAliases } from '../build/aliases.ts'
import { errors } from '../diagnostics.ts'
import type { BundledPackage } from '../diagnostics.ts'
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

export interface BundledPackagesOptions {
  cwd: string
  /** The packages that may be bundled. */
  allowed: Array<string | RegExp>
  /** Whether the options come from `build.config.*` or `package.json` rather than a tsdown config. */
  legacy: boolean
  /** Called with the error before it is thrown. */
  onError: (error: Error) => Promise<void>
}

/**
 * Fails the build when a chunk bundles a file from a package in `node_modules` that `allowed`
 * leaves out, as tsdown's `deps.onlyBundle` does, with a diagnostic that names its importers.
 */
export function bundledPackages({ cwd, allowed, legacy, onError }: BundledPackagesOptions): Rolldown.Plugin {
  const isAllowed = (name: string) => allowed.some((pattern) => {
    if (typeof pattern === 'string') {
      return pattern === name
    }
    pattern.lastIndex = 0
    return pattern.test(name)
  })
  return {
    name: 'nuxt-module-builder:bundled-packages',
    async generateBundle(_options, bundle) {
      const found = new Map<string, Set<string>>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') {
          continue
        }
        for (const id of chunk.moduleIds) {
          const name = installedPackage(id)
          if (!name || isAllowed(name) || TSDOWN_SHIMS_RE.test(normalize(id))) {
            continue
          }
          const importers = found.get(name) ?? new Set()
          found.set(name, importers)
          for (const importer of this.getModuleInfo(id)?.importers ?? []) {
            const from = installedPackage(importer)
            if (from !== name) {
              importers.add(from ? `\`${from}\`` : relative(cwd, normalize(importer)))
            }
          }
        }
      }
      if (found.size) {
        const packages: BundledPackage[] = [...found].map(([name, importers]) => ({ name, importers: [...importers] }))
        const error = errors.NUXT_MB_B0004({ packages, legacy, sources: [join(cwd, 'package.json'), ...packages.flatMap(({ importers }) => importers.filter(importer => !importer.startsWith('`')).map(importer => join(cwd, importer)))] })
        await onError(error)
        throw error
      }
    },
  }
}

const NODE_MODULES = '/node_modules/'
/** The file tsdown injects for `__dirname` and `__filename` with its `shims` option. */
const TSDOWN_SHIMS_RE = /\/node_modules\/tsdown\/esm-shims\.js$/

/** The name of the package in `node_modules` that `id` belongs to, read from its path as tsdown does. */
function installedPackage(id: string) {
  const file = normalize(id)
  const index = file.lastIndexOf(NODE_MODULES)
  if (index === -1) {
    return
  }
  const [first, second] = file.slice(index + NODE_MODULES.length).split('/')
  const name = first?.startsWith('@') && second ? `${first}/${second}` : first
  return name && existsSync(join(file.slice(0, index + NODE_MODULES.length), name, 'package.json')) ? name : undefined
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
