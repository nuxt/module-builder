import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'pathe'
import { consola } from 'consola'
import type { PackageJson } from 'pkg-types'

import type { BuildContext, BuildHook } from './define.ts'
import { guide } from './guide.ts'
import type { GuideSection } from './guide.ts'
import { findUnresolvableImports, formatUnresolvableImports, importModule, probe } from './loader.ts'

const BUILD_CONFIG_FILES = ['build.config.ts', 'build.config.mts', 'build.config.js', 'build.config.mjs']

const DEFINE_BUILD_CONFIG_STUB = [
  'export const defineBuildConfig = config => config',
  'export const definePreset = preset => preset',
].join('\n')

const ACCEPTED_KEYS = new Set(['entries', 'externals', 'replace', 'rollup', 'declaration', 'failOnWarn', 'name', 'parallel', 'clean', 'rootDir', 'outDir', 'sourcemap'])
const ENTRY_KEYS = new Set(['input', 'name', 'builder', 'outDir', 'declaration'])
const DIRECTORY_EXTENSIONS = ['mjs', 'js'] as const

const SUPPORTED_HOOKS = ['build:before', 'rollup:done', 'build:done'] as const
export type SupportedHook = typeof SUPPORTED_HOOKS[number]
const REPLACE_OPTION_KEYS = new Set(['values', 'delimiters', 'preventAssignment', 'objectGuards', 'sourcemap', 'sourceMap'])

export interface BuildConfigSource {
  /** Where the config came from, used in diagnostics. */
  name: string
  config: unknown
}

export interface DirectoryEntry {
  srcDir: string
  outDir: string
  /** Script extension; declarations use the matching `.d.mts` or `.d.ts`. */
  ext: typeof DIRECTORY_EXTENSIONS[number]
}

export interface ReplaceOptions {
  values: Record<string, string>
  delimiters?: [string, string]
  preventAssignment?: boolean
  objectGuards?: boolean
}

export interface TranslatedBuildConfig {
  /** Bundled entries keyed by output name, as paths relative to the module root. */
  entries: Record<string, string>
  /** Directories built file by file, in the same way as `src/runtime`. */
  directories: DirectoryEntry[]
  neverBundle: RegExp[]
  replace?: ReplaceOptions
  sourcemap: boolean
  declaration?: unknown
  hooks: Record<SupportedHook, BuildHook[]>
  /** Hooks that are skipped because there is nothing for them to act on, as `<source>: <hook>`. */
  ignoredHooks: string[]
  /** Options without an equivalent, as `<source>: <option>`. */
  unsupported: string[]
}

export interface TranslateBuildConfigOptions {
  cwd: string
  outDir: string
}

/**
 * Translate unbuild configs into the equivalent build options. Sources are given in
 * unbuild's precedence order: `build.config.*` first, then `package.json`'s `unbuild` or
 * `build`.
 */
export function translateBuildConfig(sources: BuildConfigSource[], options: TranslateBuildConfigOptions): TranslatedBuildConfig {
  const cwd = resolve(options.cwd)
  const outDir = resolve(options.outDir)
  const result: TranslatedBuildConfig = {
    entries: {},
    directories: [],
    neverBundle: [],
    sourcemap: false,
    hooks: { 'build:before': [], 'rollup:done': [], 'build:done': [] },
    ignoredHooks: [],
    unsupported: [],
  }
  const replace: ReplaceOptions = { values: {}, preventAssignment: true }
  let replaceDisabled = false
  const runtime = { srcDir: resolve(cwd, 'src/runtime'), outDir: resolve(outDir, 'runtime') }

  for (const { name: source, config } of sources) {
    const unsupported = (option: string) => result.unsupported.push(`${source}: ${option}`)

    if (!isPlainObject(config)) {
      unsupported('(not an object)')
      continue
    }

    for (const [key, value] of Object.entries(config)) {
      switch (key) {
        case 'entries':
          for (const [index, entry] of (Array.isArray(value) ? value : [value]).entries()) {
            translateEntry(entry, `entries[${index}]`)
          }
          break
        case 'externals':
          for (const [index, external] of (Array.isArray(value) ? value : [value]).entries()) {
            if (typeof external === 'string') {
              result.neverBundle.push(new RegExp(`^${escapeRegExp(external)}(?:/|$)`))
            }
            else if (external instanceof RegExp) {
              result.neverBundle.push(external)
            }
            else {
              unsupported(`externals[${index}]`)
            }
          }
          break
        case 'replace':
          addReplaceValues(value, 'replace')
          break
        case 'rollup':
          translateRollup(value)
          break
        case 'sourcemap':
          result.sourcemap ||= value === true
          break
        case 'declaration':
          result.declaration ??= value
          break
        case 'clean':
          if (value === false) {
            unsupported('clean: false')
          }
          break
        case 'rootDir':
          if (typeof value !== 'string' || resolve(cwd, value) !== cwd) {
            unsupported('rootDir')
          }
          break
        case 'outDir':
          if (typeof value !== 'string' || resolve(cwd, value) !== outDir) {
            unsupported('outDir')
          }
          break
        case 'hooks':
          if (!isPlainObject(value)) {
            unsupported('hooks')
            break
          }
          for (const [hook, fn] of Object.entries(value)) {
            if (typeof fn !== 'function') {
              unsupported(`hooks['${hook}']`)
            }
            else if ((SUPPORTED_HOOKS as readonly string[]).includes(hook)) {
              result.hooks[hook as SupportedHook].push(fn as BuildHook)
            }
            else if (hook.startsWith('mkdist:')) {
              result.ignoredHooks.push(`${source}: hooks['${hook}']`)
            }
            else {
              unsupported(`hooks['${hook}']`)
            }
          }
          break
        default:
          if (!ACCEPTED_KEYS.has(key)) {
            unsupported(key)
          }
      }
    }

    function translateEntry(entry: unknown, path: string) {
      const normalised = typeof entry === 'string' ? { input: entry } : entry
      if (!isPlainObject(normalised) || typeof normalised.input !== 'string' || !normalised.input) {
        unsupported(path)
        return
      }

      const input = normalised.input
      const builder = normalised.builder ?? (input.endsWith('/') ? 'mkdist' : 'rollup')

      for (const [key, option] of Object.entries(normalised)) {
        if (ENTRY_KEYS.has(key)) {
          continue
        }
        // Relative declaration specifiers always carry their extension.
        if (builder === 'mkdist' && (key === 'addRelativeDeclarationExtensions' || (key === 'ext' && DIRECTORY_EXTENSIONS.includes(option as DirectoryEntry['ext'])))) {
          continue
        }
        unsupported(`${path}.${key}`)
      }

      const entryOutDir = typeof normalised.outDir === 'string' ? resolve(cwd, normalised.outDir) : outDir

      if (builder === 'mkdist') {
        const directory: DirectoryEntry = { srcDir: resolve(cwd, input), outDir: entryOutDir, ext: normalised.ext === 'js' ? 'js' : 'mjs' }
        if (relative(outDir, directory.outDir).startsWith('..')) {
          unsupported(`${path}.outDir`)
        }
        else if (directory.srcDir !== runtime.srcDir || directory.outDir !== runtime.outDir) {
          result.directories.push(directory)
        }
        return
      }

      if (builder !== 'rollup') {
        unsupported(`${path}.builder: '${String(builder)}'`)
        return
      }
      if (entryOutDir !== outDir) {
        unsupported(`${path}.outDir`)
        return
      }

      const name = typeof normalised.name === 'string' ? normalised.name : entryName(input, cwd)
      const file = probe(resolve(cwd, input)) ?? resolve(cwd, `${input}.ts`)
      result.entries[name] = `./${relative(cwd, file)}`
    }

    function translateRollup(value: unknown) {
      if (!isPlainObject(value)) {
        unsupported('rollup')
        return
      }
      for (const [key, option] of Object.entries(value)) {
        if ((key === 'emitCJS' || key === 'cjsBridge') && !option) {
          continue
        }
        if (key === 'replace') {
          translateRollupReplace(option)
          continue
        }
        // `output.exports` only affects CommonJS output, which is never emitted.
        if (key === 'output' && isPlainObject(option) && Object.keys(option).every(name => name === 'exports')) {
          continue
        }
        unsupported(key === 'emitCJS' || key === 'cjsBridge' ? `rollup.${key}: true` : `rollup.${key}`)
      }
    }

    function translateRollupReplace(option: unknown) {
      if (option === false) {
        replaceDisabled = true
        return
      }
      if (!isPlainObject(option)) {
        unsupported('rollup.replace')
        return
      }
      for (const [key, value] of Object.entries(option)) {
        if (!REPLACE_OPTION_KEYS.has(key)) {
          unsupported(`rollup.replace.${key}`)
        }
        else if (key === 'values') {
          addReplaceValues(value, 'rollup.replace.values')
        }
        else if (key === 'delimiters') {
          if (Array.isArray(value) && value.length === 2 && value.every(d => typeof d === 'string')) {
            replace.delimiters ??= value as [string, string]
          }
          else {
            unsupported('rollup.replace.delimiters')
          }
        }
        else if (key === 'preventAssignment' || key === 'objectGuards') {
          replace[key] = value === true
        }
      }
    }

    function addReplaceValues(values: unknown, path: string) {
      if (!isPlainObject(values)) {
        unsupported(path)
        return
      }
      for (const [search, replacement] of Object.entries(values)) {
        if (typeof replacement !== 'string') {
          unsupported(`${path}['${search}']`)
        }
        else if (!Object.hasOwn(replace.values, search)) {
          replace.values[search] = replacement
        }
      }
    }
  }

  if (!replaceDisabled && Object.keys(replace.values).length) {
    result.replace = replace
  }

  return result
}

/** The output name unbuild infers for an entry without an explicit `name`. */
export function entryName(input: string, cwd: string): string {
  let relativeInput = isAbsolute(input) ? relative(cwd, input) : normalize(input)
  if (relativeInput.startsWith('./')) {
    relativeInput = relativeInput.slice(2)
  }
  return relativeInput.replace(/^src\//, '').replace(/\.(?:js|mjs|cjs|ts|mts|cts|json|jsx|tsx)$/, '')
}

export interface LoadedBuildConfig extends TranslatedBuildConfig {
  /** The `build.config.*` file that was read, if any. */
  file?: string
  /** Whether that file still imports from `unbuild`. */
  importsUnbuild?: boolean
  /** The `package.json` field that was read, if any. */
  field?: 'unbuild' | 'build'
}

const UNBUILD_IMPORT_RE = /\bfrom\s*['"]unbuild['"]/

/** Resolves `outDir` against `cwd`, refusing a directory the build would empty the module root with. */
export function resolveOutDir(cwd: string, outDir: string, label: string = `--outDir ${outDir}`): string {
  const resolved = resolve(cwd, outDir)
  if (!relative(resolved, cwd).startsWith('..')) {
    throw new Error(`\`${label}\` resolves to \`${resolved}\`, which contains the module root; the build empties the output directory first. Use a directory inside the module such as \`dist\`. ${guide('output-directory')}`)
  }
  return resolved
}

/**
 * Read `build.config.*` and `package.json`'s `unbuild` (or, failing that, `build`) field
 * and translate them. Neither `unbuild` nor this package is loaded to evaluate the file:
 * `defineBuildConfig` is replaced with the identity.
 */
export async function loadBuildConfig(cwd: string, pkg: PackageJson, outDir: string): Promise<LoadedBuildConfig> {
  const sources: BuildConfigSource[] = []
  let configCount = 0

  const field = pkg.unbuild !== undefined ? 'unbuild' : pkg.build !== undefined ? 'build' : undefined
  const fieldSource = field ? [{ name: `package.json "${field}"`, config: pkg[field] }] : []

  let importsUnbuild: boolean | undefined
  const file = BUILD_CONFIG_FILES.find(file => existsSync(resolve(cwd, file)))
  if (file) {
    importsUnbuild = UNBUILD_IMPORT_RE.test(await readFile(resolve(cwd, file), 'utf8'))
    const stubs = { 'unbuild': DEFINE_BUILD_CONFIG_STUB, '@nuxt/module-builder': DEFINE_BUILD_CONFIG_STUB }
    const unresolvable = findUnresolvableImports(cwd, [file], [])
    if (unresolvable.length) {
      const withoutFile = translateBuildConfig(fieldSource, { cwd, outDir })
      const runtimeDirs = [resolve(cwd, 'src/runtime'), ...withoutFile.directories.map(directory => directory.srcDir)]
      unresolvable.push(...findUnresolvableImports(cwd, Object.values(bundledEntries(cwd, withoutFile)), runtimeDirs))
      throw new Error(formatUnresolvableImports(unresolvable))
    }
    const { default: config } = await importModule(resolve(cwd, file), { cwd, stubs })
    if (typeof config === 'function') {
      throw new TypeError(`\`${file}\` must export a config object, not a function. Replace the function with the object it returns. ${guide('other-options')}`)
    }
    const configs = (Array.isArray(config) ? config : [config]).filter(Boolean)
    sources.push(...configs.map(config => ({ name: file, config })))
    configCount = configs.length
  }

  sources.push(...fieldSource)

  const translated = translateBuildConfig(sources, { cwd, outDir })
  translated.neverBundle.push(...inferredExternals(pkg))
  if (configCount > 1) {
    translated.unsupported.unshift(`${file}: an array of ${configCount} configs`)
  }
  return { file, importsUnbuild, field, ...translated }
}

/** An entry of `builder({ entries })`. */
export type BuilderEntry
  = | string
    | { input: string, name?: string, builder?: 'rollup' }
    | { input: string, builder?: 'mkdist', outDir?: string, ext?: 'mjs' | 'js' }

/** The key `builder()` keeps its options under, so `--stub` and `prepare` can find them in a tsdown config. */
export const BUILDER_OPTIONS: unique symbol = Symbol.for('@nuxt/module-builder:builder-options')

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

const MODULE_OPTION_KEYS = new Set(['entries', 'externals', 'replace'])

/** Resolves the options of `builder()` into bundled entries, transpiled directories and build settings. */
export function resolveModuleOptions(cwd: string, pkg: PackageJson, outDir: string, options: BuilderOptions): LoadedBuildConfig {
  if ('hooks' in options) {
    throw new Error(`\`builder()\` does not take \`hooks\`. Use tsdown's own \`hooks\` in the tsdown config, or a plugin that emits extra files. ${guide('hooks-in-a-tsdown-config')}`)
  }
  const { entries, externals, replace } = options
  const config: Record<string, unknown> = {
    ...entries !== undefined && { entries },
    ...externals !== undefined && { externals },
    ...replace !== undefined && (isPlainObject(replace) && isPlainObject(replace.values) ? { rollup: { replace } } : { replace }),
  }
  const translated = translateBuildConfig([{ name: 'builder()', config }], { cwd, outDir })
  translated.unsupported.push(...Object.keys(options).filter(key => !MODULE_OPTION_KEYS.has(key)).map(key => `builder(): ${key}`))
  translated.neverBundle.push(...inferredExternals(pkg))
  return translated
}

/**
 * Fails when `build.config.*` or a `build` or `unbuild` field of `package.json` would
 * configure the build alongside `builder()`.
 */
export function assertNoLegacyBuildConfig(cwd: string, pkg: PackageJson): void {
  const file = BUILD_CONFIG_FILES.find(file => existsSync(resolve(cwd, file)))
  const field = pkg.unbuild !== undefined ? 'unbuild' : pkg.build !== undefined ? 'build' : undefined
  if (file || field) {
    const source = file ? `\`${file}\`` : `The \`${field}\` field of \`package.json\``
    const advice = file ? 'delete the file' : 'remove the field'
    throw new Error(`${source} configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and ${advice}. ${guide('moving-from-buildconfigts')}`)
  }
}

/** `src/module` plus the translated extra entries, keyed by output name. */
export function bundledEntries(cwd: string, config: TranslatedBuildConfig): { module: string, [name: string]: string } {
  const module = probe(resolve(cwd, 'src/module')) ?? resolve(cwd, 'src/module.ts')
  return { ...config.entries, module: `./${relative(cwd, module)}` }
}

export function warnDeprecatedBuildConfig(config: LoadedBuildConfig): void {
  for (const hook of config.ignoredHooks) {
    consola.warn(`Ignoring ${hook}: runtime files are no longer built with mkdist. Remove the hook. ${guide('hooks')}`)
  }
  if (config.file) {
    consola.warn([
      `\`${config.file}\` is deprecated. Its options are still applied.`,
      ...config.importsUnbuild ? ['Import `defineBuildConfig` from `@nuxt/module-builder` instead of `unbuild`.'] : [],
      'Move them into `builder()` in `tsdown.config.ts`.',
      guide('moving-from-buildconfigts'),
    ].join(' '))
  }
  if (config.field === 'unbuild') {
    consola.warn(`The \`unbuild\` field of \`package.json\` is deprecated. Its options are still applied. Rename the field to \`build\`. ${guide('build-configuration')}`)
  }
}

export interface BuildContextOptions {
  cwd: string
  outDir: string
  pkg: PackageJson
  config: TranslatedBuildConfig
  directories: DirectoryEntry[]
  stub: boolean
  sourcemap: boolean
}

export function createBuildContext({ cwd, outDir, pkg, config, directories, stub, sourcemap }: BuildContextOptions): BuildContext {
  return {
    options: {
      name: (pkg.name || '').split('/').pop() || 'default',
      rootDir: cwd,
      outDir,
      entries: [
        ...Object.entries(bundledEntries(cwd, config)).map(([name, input]) => ({ input: resolve(cwd, input), name, builder: 'rollup' as const, outDir })),
        ...directories.map(({ srcDir, outDir }) => ({ input: `${srcDir}/`, name: entryName(relative(cwd, srcDir), cwd), builder: 'mkdist' as const, outDir })),
      ],
      declaration: config.declaration,
      stub,
      sourcemap,
    },
    pkg,
  }
}

export async function callBuildHook(config: TranslatedBuildConfig, hook: SupportedHook, ctx: BuildContext): Promise<void> {
  for (const fn of config.hooks[hook]) {
    await fn(ctx)
  }
}

export function formatUnsupportedOptions(unsupported: string[]): string {
  return [
    'The build config uses options that `@nuxt/module-builder` v2 does not support:',
    ...unsupported.map(option => `  - ${option} (${guide(unsupportedOptionSection(option))})`),
    `Remove each of them from the file named. ${guide('unsupported-build-options')}`,
  ].join('\n')
}

function unsupportedOptionSection(option: string): GuideSection {
  const name = option.slice(option.indexOf(': ') + 2)
  if (name.startsWith('hooks[')) {
    return 'hooks'
  }
  if (name.startsWith('rollup.emitCJS')) {
    return 'commonjs-output'
  }
  if (name.startsWith('rollup')) {
    return 'rollup-options'
  }
  if (/^entries\[\d+\]\.(?!outDir|builder)/.test(name)) {
    return 'mkdist-options'
  }
  return 'other-options'
}

/**
 * The module's own package name and its `#` subpath imports, which are never bundled.
 * Self-referencing imports of the runtime tree are left to `runtimeExternals`.
 */
function inferredExternals(pkg: PackageJson) {
  const externals: RegExp[] = []
  if (pkg.name) {
    externals.push(new RegExp(`^${escapeRegExp(pkg.name)}(?:$|/(?!runtime/))`))
  }
  for (const name of Object.keys(pkg.imports || {})) {
    if (name.startsWith('#')) {
      externals.push(new RegExp(`^${escapeRegExp(name).replace(/\\\*/g, '.*')}$`))
    }
  }
  return externals
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
