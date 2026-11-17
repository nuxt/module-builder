/**
 * Reads a v1 module's `build.config.*` and the `unbuild` or `build` field of `package.json`,
 * translates them into the build's options, and runs their unbuild hooks.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'

import type { BuildPlan } from '../build/build.ts'
import { guide } from '../build/guide.ts'
import type { GuideSection } from '../build/guide.ts'
import { findModuleCodeIssues, formatModuleCodeIssues, importModule } from '../build/loader.ts'
import { bundledEntries, createOptionsCollector, entryName } from '../build/options.ts'
import type { BuildHookName, ModuleConfig } from '../build/options.ts'
import { isPlainObject, logger } from '../utils.ts'
import type { BuildContext, BuildHook } from './define.ts'

const BUILD_CONFIG_FILES = ['build.config.ts', 'build.config.mts', 'build.config.js', 'build.config.mjs']

const DEFINE_BUILD_CONFIG_STUB = [
  'export const defineBuildConfig = config => config',
  'export const definePreset = preset => preset',
].join('\n')

const ACCEPTED_KEYS = new Set(['failOnWarn', 'name', 'parallel'])
const SUPPORTED_HOOKS: readonly string[] = ['build:before', 'rollup:done', 'build:done'] satisfies BuildHookName[]
const UNBUILD_IMPORT_RE = /\bfrom\s*['"]unbuild['"]/

export interface BuildConfigSource {
  /** Where the config came from, used in diagnostics. */
  name: string
  config: unknown
}

export interface TranslatedBuildConfig extends ModuleConfig {
  hooks: Record<BuildHookName, BuildHook[]>
  /** Hooks that are skipped because there is nothing for them to act on, as `<source>: <hook>`. */
  ignoredHooks: string[]
  /** Options without an equivalent, as `<source>: <option>`. */
  unsupported: string[]
}

export interface LoadedBuildConfig extends TranslatedBuildConfig {
  /** The `build.config.*` file that was read, if any. */
  file?: string
  /** Whether that file still imports from `unbuild`. */
  importsUnbuild?: boolean
  /** The `package.json` field that was read, if any. */
  field?: 'unbuild' | 'build'
}

/**
 * Translate unbuild configs into the equivalent build options. Sources are given in
 * unbuild's precedence order: `build.config.*` first, then `package.json`'s `unbuild` or
 * `build`.
 */
export function translateBuildConfig(sources: BuildConfigSource[], options: { cwd: string, outDir: string, pkg?: PackageJson }): TranslatedBuildConfig {
  const cwd = resolve(options.cwd)
  const outDir = resolve(options.outDir)
  const collector = createOptionsCollector(cwd, outDir)
  const hooks: TranslatedBuildConfig['hooks'] = { 'build:before': [], 'rollup:done': [], 'build:done': [] }
  const ignoredHooks: string[] = []
  const rejected: string[] = []
  let sourcemap = false
  let declaration: unknown
  let replaceDisabled = false

  for (const { name: source, config } of sources) {
    const unsupported = (option: string) => rejected.push(`${source}: ${option}`)

    if (!isPlainObject(config)) {
      unsupported('(not an object)')
      continue
    }

    for (const [key, value] of Object.entries(config)) {
      switch (key) {
        case 'entries':
          collector.entries((Array.isArray(value) ? value : [value]).map(withoutIgnoredEntryKeys), unsupported)
          break
        case 'externals':
          collector.externals(value, unsupported)
          break
        case 'replace':
          collector.replaceValues(value, 'replace', unsupported)
          break
        case 'rollup':
          translateRollup(value)
          break
        case 'sourcemap':
          sourcemap ||= value === true
          break
        case 'declaration':
          declaration ??= value
          break
        case 'clean':
          if (value === false) {
            unsupported('clean: false')
          }
          break
        case 'rootDir':
        case 'outDir':
          if (typeof value !== 'string' || resolve(cwd, value) !== (key === 'rootDir' ? cwd : outDir)) {
            unsupported(key)
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
            else if (SUPPORTED_HOOKS.includes(hook)) {
              hooks[hook as BuildHookName].push(fn as BuildHook)
            }
            else if (hook.startsWith('mkdist:')) {
              ignoredHooks.push(`${source}: hooks['${hook}']`)
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

    function translateRollup(value: unknown) {
      if (!isPlainObject(value)) {
        unsupported('rollup')
        return
      }
      for (const [key, option] of Object.entries(value)) {
        if ((key === 'emitCJS' || key === 'cjsBridge') && !option) {
          continue
        }
        if (key === 'replace' && option === false) {
          replaceDisabled = true
        }
        else if (key === 'replace' && isPlainObject(option)) {
          const { sourcemap: _, sourceMap: __, ...replace } = option
          collector.replaceOptions(replace, 'rollup.replace', unsupported)
        }
        // `output.exports` only affects CommonJS output, which is never emitted.
        else if (!(key === 'output' && isPlainObject(option) && Object.keys(option).every(name => name === 'exports'))) {
          unsupported(key === 'emitCJS' || key === 'cjsBridge' ? `rollup.${key}: true` : `rollup.${key}`)
        }
      }
    }
  }

  let ctx: BuildContext | undefined
  return {
    ...collector.finish(options.pkg ?? {}, { replace: !replaceDisabled }),
    sourcemap,
    hooks,
    ignoredHooks,
    unsupported: rejected,
    async callHook(hook, plan) {
      ctx ??= createBuildContext(plan, declaration)
      for (const fn of hooks[hook]) {
        await fn(ctx)
      }
    },
  }
}

/** Declarations are always generated, and relative declaration specifiers always carry their extension. */
function withoutIgnoredEntryKeys(entry: unknown) {
  if (!isPlainObject(entry)) {
    return entry
  }
  const { declaration: _, ...rest } = entry
  if ((rest.builder ?? (String(rest.input).endsWith('/') ? 'mkdist' : 'rollup')) === 'mkdist') {
    delete rest.addRelativeDeclarationExtensions
  }
  return rest
}

/**
 * Read `build.config.*` and `package.json`'s `unbuild` (or, failing that, `build`) field
 * and translate them. Neither `unbuild` nor this package is loaded to evaluate the file:
 * `defineBuildConfig` is replaced with the identity.
 */
export async function loadBuildConfig(cwd: string, pkg: PackageJson, outDir: string): Promise<LoadedBuildConfig> {
  const field = buildConfigField(pkg)
  const fieldSource = field ? [{ name: `package.json "${field}"`, config: pkg[field] }] : []

  let importsUnbuild: boolean | undefined
  let configs: unknown[] = []
  const file = BUILD_CONFIG_FILES.find(file => existsSync(resolve(cwd, file)))
  if (file) {
    importsUnbuild = UNBUILD_IMPORT_RE.test(await readFile(resolve(cwd, file), 'utf8'))
    const stubs = { 'unbuild': DEFINE_BUILD_CONFIG_STUB, '@nuxt/module-builder': DEFINE_BUILD_CONFIG_STUB }
    const unresolvable = findModuleCodeIssues(cwd, [file], [])
    if (unresolvable.length) {
      const withoutFile = translateBuildConfig(fieldSource, { cwd, outDir })
      const runtimeDirs = [resolve(cwd, 'src/runtime'), ...withoutFile.directories.map(directory => directory.srcDir)]
      const entries = bundledEntries(cwd, withoutFile)
      unresolvable.push(...findModuleCodeIssues(cwd, [entries.module], runtimeDirs, Object.values(entries)))
      throw new Error(formatModuleCodeIssues(unresolvable))
    }
    const { default: config } = await importModule(resolve(cwd, file), { cwd, stubs })
    if (typeof config === 'function') {
      throw new TypeError(`\`${file}\` must export a config object, not a function. Replace the function with the object it returns. ${guide('other-options')}`)
    }
    configs = (Array.isArray(config) ? config : [config]).filter(Boolean)
  }

  const translated = translateBuildConfig([...configs.map(config => ({ name: file!, config })), ...fieldSource], { cwd, outDir, pkg })
  if (configs.length > 1) {
    translated.unsupported.unshift(`${file}: an array of ${configs.length} configs`)
  }
  return Object.assign(translated, { file, importsUnbuild, field })
}

/** {@link loadBuildConfig}, failing on options without an equivalent and warning about deprecated ones. */
export async function loadLegacyModuleConfig(cwd: string, pkg: PackageJson, outDir: string): Promise<ModuleConfig> {
  const config = await loadBuildConfig(cwd, pkg, outDir)
  if (config.unsupported.length) {
    throw new Error(formatUnsupportedOptions(config.unsupported))
  }
  warnDeprecatedBuildConfig(config)
  return config
}

/**
 * Fails when `build.config.*` or a `build` or `unbuild` field of `package.json` would
 * configure the build alongside `builder()`.
 */
export function assertNoLegacyBuildConfig(cwd: string, pkg: PackageJson): void {
  const file = BUILD_CONFIG_FILES.find(file => existsSync(resolve(cwd, file)))
  const field = buildConfigField(pkg)
  if (file || field) {
    const source = file ? `\`${file}\`` : `The \`${field}\` field of \`package.json\``
    const advice = file ? 'delete the file' : 'remove the field'
    throw new Error(`${source} configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and ${advice}. ${guide('moving-from-buildconfigts')}`)
  }
}

export function warnDeprecatedBuildConfig(config: LoadedBuildConfig): void {
  for (const hook of config.ignoredHooks) {
    logger.warn(`Ignoring ${hook}: runtime files are no longer built with mkdist. Remove the hook. ${guide('hooks')}`)
  }
  if (config.file) {
    logger.warn([
      `\`${config.file}\` is deprecated. Its options are still applied.`,
      ...config.importsUnbuild ? ['Import `defineBuildConfig` from `@nuxt/module-builder` instead of `unbuild`.'] : [],
      'Move them into `builder()` in `tsdown.config.ts`.',
      guide('moving-from-buildconfigts'),
    ].join(' '))
  }
  if (config.field === 'unbuild') {
    logger.warn(`The \`unbuild\` field of \`package.json\` is deprecated. Its options are still applied. Rename the field to \`build\`. ${guide('build-configuration')}`)
  }
}

function buildConfigField(pkg: PackageJson): LoadedBuildConfig['field'] {
  return pkg.unbuild !== undefined ? 'unbuild' : pkg.build !== undefined ? 'build' : undefined
}

function createBuildContext({ cwd, outDir, pkg, entries, directories, sourcemap }: BuildPlan, declaration: unknown): BuildContext {
  return {
    options: {
      name: (pkg.name || '').split('/').pop() || 'default',
      rootDir: cwd,
      outDir,
      entries: [
        ...Object.entries(entries).map(([name, input]) => ({ input: resolve(cwd, input), name, builder: 'rollup' as const, outDir })),
        ...directories.map(({ srcDir, outDir }) => ({ input: `${srcDir}/`, name: entryName(relative(cwd, srcDir), cwd), builder: 'mkdist' as const, outDir })),
      ],
      declaration,
      stub: false,
      sourcemap,
    },
    pkg,
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
