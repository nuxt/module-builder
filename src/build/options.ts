import { isAbsolute, normalize, relative, resolve } from 'pathe'

import { assertNoLegacyBuildConfig } from '../legacy/build-config.ts'
import { escapeRegExp, isInside, isPlainObject, probe, realpath } from '../utils.ts'
import type { PackageJson } from '../utils.ts'
import type { BuildPlan } from './build.ts'
import { guide } from './guide.ts'

export const NUXT_EXTERNALS: (string | RegExp)[] = [
  '@nuxt/schema',
  '@nuxt/schema-nightly',
  '@nuxt/schema-edge',
  '@nuxt/kit',
  '@nuxt/kit-nightly',
  '@nuxt/kit-edge',
  /^#app(\/|$)/,
  /^#build(\/|$)/,
  /^#imports$/,
  /^nuxt(\/|$)/,
  'nuxt-nightly',
  'nuxt-edge',
  'nuxt3',
  'vue',
  'vue-demi',
]

const ENTRY_KEYS = new Set(['input', 'name', 'builder', 'outDir', 'ext'])
const DIRECTORY_EXTENSIONS = ['mjs', 'js'] as const

/** The key `builder()` keeps its options under, so `prepare` can find them in a tsdown config. */
export const BUILDER_OPTIONS: unique symbol = Symbol.for('@nuxt/module-builder:builder-options')

/** An entry of `builder({ entries })`. */
export type BuilderEntry
  = | string
    | { input: string, name?: string, builder?: 'rollup' }
    | { input: string, builder?: 'mkdist', outDir?: string, ext?: 'mjs' | 'js' }

export interface ReplaceOptions {
  values: Record<string, string>
  delimiters?: [string, string]
  preventAssignment?: boolean
  objectGuards?: boolean
}

export interface BuilderOptions {
  /**
   * Entries built besides `src/module`. A path, or `{ input, name }`, is bundled. An `input`
   * ending in `/` (or `builder: 'mkdist'`) is a directory transpiled file by file like
   * `src/runtime`, into `outDir` (inside the build's output directory) with the `ext` scripts
   * get: `mjs` (the default) or `js`.
   */
  entries?: BuilderEntry[]
  /** Imports that are never bundled. A string matches the package and its subpaths. */
  externals?: Array<string | RegExp>
  /** Compile-time replacements in bundled entries, as `{ search: replacement }` or the options of rolldown's replace plugin. */
  replace?: Record<string, string> | ReplaceOptions
}

export interface DirectoryEntry {
  srcDir: string
  outDir: string
  /** Script extension; declarations use the matching `.d.mts` or `.d.ts`. */
  ext: typeof DIRECTORY_EXTENSIONS[number]
}

export type BuildHookName = 'build:before' | 'rollup:done' | 'build:done'

export interface ModuleConfig {
  /** Bundled entries keyed by output name, as paths relative to the module root. */
  entries: Record<string, string>
  /** Directories built file by file, in the same way as `src/runtime`. */
  directories: DirectoryEntry[]
  neverBundle: RegExp[]
  replace?: ReplaceOptions
  /** Set when source maps are enabled in `build.config.ts`. */
  sourcemap?: boolean
  /** Runs the hooks of a `build.config.ts`. */
  callHook?: (hook: BuildHookName, plan: BuildPlan) => Promise<void>
}

type Report = (option: string) => void

export interface OptionsCollector {
  entries: (entries: unknown, report: Report) => void
  externals: (externals: unknown, report: Report) => void
  replaceValues: (values: unknown, path: string, report: Report) => void
  replaceOptions: (options: Record<string, unknown>, path: string, report: Report) => void
  /** The collected options, with the module's own package name never bundled. */
  finish: (pkg: PackageJson, options?: { replace?: boolean }) => ModuleConfig
}

/**
 * Collects entries, externals and replacements from one or more option sources. Of two
 * sources that set the same replacement or replace option, the first one wins. Options that
 * cannot be applied are passed to `report`, by their path.
 */
export function createOptionsCollector(cwd: string, outDir: string): OptionsCollector {
  const config: ModuleConfig = { entries: {}, directories: [], neverBundle: [] }
  const replace: ReplaceOptions = { values: {} }
  const runtime = { srcDir: resolve(cwd, 'src/runtime'), outDir: resolve(outDir, 'runtime') }

  function entry(value: unknown, path: string, report: Report) {
    const normalised = typeof value === 'string' ? { input: value } : value
    if (!isPlainObject(normalised) || typeof normalised.input !== 'string' || !normalised.input) {
      report(path)
      return
    }
    const input = normalised.input
    const builder = normalised.builder ?? (input.endsWith('/') ? 'mkdist' : 'rollup')
    for (const [key, option] of Object.entries(normalised)) {
      if (!ENTRY_KEYS.has(key) || (key === 'ext' && !(builder === 'mkdist' && DIRECTORY_EXTENSIONS.includes(option as DirectoryEntry['ext'])))) {
        report(`${path}.${key}`)
      }
    }

    const entryOutDir = typeof normalised.outDir === 'string' ? resolve(cwd, normalised.outDir) : outDir
    if (builder === 'mkdist') {
      const directory: DirectoryEntry = { srcDir: resolve(cwd, input), outDir: entryOutDir, ext: normalised.ext === 'js' ? 'js' : 'mjs' }
      if (!isInside(outDir, directory.outDir)) {
        report(`${path}.outDir`)
      }
      else if (directory.srcDir !== runtime.srcDir || directory.outDir !== runtime.outDir) {
        config.directories.push(directory)
      }
      return
    }
    if (builder !== 'rollup') {
      report(`${path}.builder: '${String(builder)}'`)
      return
    }
    if (entryOutDir !== outDir) {
      report(`${path}.outDir`)
      return
    }

    const name = typeof normalised.name === 'string' ? normalised.name : entryName(input, cwd)
    if (name.toLowerCase() === 'types') {
      throw new Error(`A bundled entry is named \`types\`, whose declarations would replace the generated \`types.d.mts\`. Give \`${input}\` another \`name\`.`)
    }
    config.entries[name] = entryPath(cwd, input)
  }

  function replaceValues(values: unknown, path: string, report: Report) {
    if (!isPlainObject(values)) {
      report(path)
      return
    }
    for (const [search, replacement] of Object.entries(values)) {
      if (typeof replacement !== 'string') {
        report(`${path}['${search}']`)
      }
      else if (!Object.hasOwn(replace.values, search)) {
        replace.values[search] = replacement
      }
    }
  }

  return {
    entries(entries, report) {
      for (const [index, value] of (Array.isArray(entries) ? entries : [entries]).entries()) {
        entry(value, `entries[${index}]`, report)
      }
    },
    externals(externals, report) {
      for (const [index, external] of (Array.isArray(externals) ? externals : [externals]).entries()) {
        if (typeof external === 'string') {
          config.neverBundle.push(new RegExp(`^${escapeRegExp(external)}(?:/|$)`))
        }
        else if (external instanceof RegExp) {
          config.neverBundle.push(external)
        }
        else {
          report(`externals[${index}]`)
        }
      }
    },
    replaceValues,
    replaceOptions(options, path, report) {
      for (const [key, value] of Object.entries(options)) {
        if (key === 'values') {
          replaceValues(value, `${path}.values`, report)
        }
        else if (key === 'delimiters' && Array.isArray(value) && value.length === 2 && value.every(delimiter => typeof delimiter === 'string')) {
          replace.delimiters ??= value as [string, string]
        }
        else if (key === 'preventAssignment' || key === 'objectGuards') {
          replace[key] ??= value === true
        }
        else {
          report(`${path}.${key}`)
        }
      }
    },
    finish(pkg, { replace: replaces = true } = {}) {
      if (replaces && Object.keys(replace.values).length) {
        config.replace = { ...replace, preventAssignment: replace.preventAssignment ?? true }
      }
      if (pkg.name) {
        config.neverBundle.push(new RegExp(`^${escapeRegExp(pkg.name)}(?:$|/(?!runtime/))`))
      }
      return config
    },
  }
}

/** Resolves the options of `builder()` into bundled entries, transpiled directories and replacements. */
export function resolveModuleOptions(cwd: string, pkg: PackageJson, outDir: string, options: BuilderOptions): ModuleConfig {
  assertNoLegacyBuildConfig(cwd, pkg)
  if ('hooks' in options) {
    throw new Error(`\`builder()\` does not take \`hooks\`. Use tsdown's own \`hooks\` in the tsdown config, or a plugin that emits extra files. ${guide('hooks-in-a-tsdown-config')}`)
  }
  const unsupported: string[] = []
  const report = (option: string) => unsupported.push(option)
  const collector = createOptionsCollector(cwd, outDir)
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) {
      continue
    }
    if (key === 'entries') {
      collector.entries(value, report)
    }
    else if (key === 'externals') {
      collector.externals(value, report)
    }
    else if (key === 'replace' && isPlainObject(value) && isPlainObject(value.values)) {
      collector.replaceOptions(value, 'replace', report)
    }
    else if (key === 'replace') {
      collector.replaceValues(value, 'replace', report)
    }
    else {
      report(key)
    }
  }
  if (unsupported.length) {
    throw new Error(['`builder()` does not support these options:', ...unsupported.map(option => `  - ${option}`), guide('tsdown-config')].join('\n'))
  }
  return collector.finish(pkg)
}

/** The output name of an entry without an explicit `name`. */
export function entryName(input: string, cwd: string): string {
  return (isAbsolute(input) ? relative(cwd, input) : normalize(input)).replace(/^\.\//, '').replace(/^src\//, '').replace(/\.(?:js|mjs|cjs|ts|mts|cts|json|jsx|tsx)$/, '')
}

/** `src/module` plus the extra bundled entries, keyed by output name. */
export function bundledEntries(cwd: string, config: ModuleConfig): { module: string, [name: string]: string } {
  return { ...config.entries, module: entryPath(cwd, 'src/module') }
}

function entryPath(cwd: string, input: string) {
  return `./${relative(cwd, probe(resolve(cwd, input)) ?? resolve(cwd, `${input}.ts`))}`
}

/** Resolves `outDir` against `cwd`, refusing a directory outside the module, which the build would empty. */
export function resolveOutDir(cwd: string, outDir: string, label: string = `--outDir ${outDir}`): string {
  const resolved = resolve(cwd, outDir)
  const root = realpath(cwd)
  const real = realpath(resolved)
  if (real === root || !isInside(root, real)) {
    throw new Error(`\`${label}\` resolves to \`${real}\`, which is not inside the module root; the build empties the output directory first. Use a directory inside the module such as \`dist\`. ${guide('output-directory')}`)
  }
  return resolved
}
