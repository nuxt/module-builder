import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve } from 'pathe'
import { consola } from 'consola'
import type { TsConfigResult } from 'get-tsconfig'
import type { PackageJson } from 'pkg-types'
import { glob } from 'tinyglobby'

import builderPkg from '../../package.json' with { type: 'json' }
import { probe as probeSource, scriptExtension, valueSpecifiers } from '../rolldown/resolve.ts'
import { DEFAULT_EXCLUDE } from '../rolldown/transpile-dir.ts'
import type { ResolveExternal } from '../rolldown/transpile-dir.ts'
import { createTsconfigResolver, declarationPaths, findPackageDir, namedCachePath, tsconfigPaths, writeDerivedTsconfig, writeServerRoutesStub } from '../rolldown/tsconfig.ts'
import { shouldAdvise } from './advice.ts'
import { rewriteRuntimeDeclarations } from './aliases.ts'
import { bundledEntries, callBuildHook, createBuildContext, formatUnsupportedOptions, warnDeprecatedBuildConfig } from './build-config.ts'
import type { DirectoryEntry, LoadedBuildConfig } from './build-config.ts'
import type { BuildContext } from './define.ts'
import { checkDeprecatedPackageFields } from './deprecations.ts'
import { NUXT_EXTERNALS } from './externals.ts'
import { guide } from './guide.ts'
import { assertResolvableImports, loadOxc, probe } from './loader.ts'
import { writeModuleMeta } from './meta.ts'
import { hasIsolatedDeclarations, selfReferencePaths } from './tsconfig.ts'
import { writeTypes } from './types.ts'

const ISOLATED_DECLARATIONS_HINT = [
  'Declaration generation failed under `isolatedDeclarations`.',
  'Every exported value needs an explicit type annotation. In particular, a module entry has to be written as:',
  '',
  '  const module: NuxtModule<ModuleOptions> = defineNuxtModule({ /* ... */ })',
  '  export default module',
  '',
  `rather than \`export default defineNuxtModule<ModuleOptions>({ /* ... */ })\`. ${guide('isolated-declarations')}`,
].join('\n')

const TYPE_ERROR_HINT = [
  'Type declarations could not be generated because of TypeScript errors.',
  `An inferred type that cannot be named (TS2742) needs an explicit type annotation on the export. ${guide('portability-errors')}`,
  `If \`.nuxt\` is out of date, run \`nuxt-module-build prepare\` and build again. ${guide('declaration-errors')}`,
].join('\n')

const SCRIPT_RE = /\.[cm]?[jt]sx?$/
const SERVER_DIR_RE = /(?:^|\/)server\//

export function shouldNudge(isolatedDeclarations: boolean): boolean {
  return !isolatedDeclarations && shouldAdvise('isolated-declarations')
}

export interface ResolveBuildOptions {
  cwd: string
  pkg: PackageJson
  /** Absolute path of the output directory, already checked with `resolveOutDir`. */
  outDir: string
  sourcemap: boolean
  /** Loads the translated build config once the module's tsconfig has been read. */
  loadConfig: () => Promise<LoadedBuildConfig>
}

/** Everything a build needs to know about the module, resolved before anything is written. */
export interface BuildPlan {
  cwd: string
  pkg: PackageJson
  outDir: string
  config: LoadedBuildConfig
  /** `src/runtime` and every other directory transpiled file by file. */
  directories: DirectoryEntry[]
  /** Bundled entries keyed by output name, as paths relative to `cwd`. */
  entries: { module: string, [name: string]: string }
  runtimeDirs: string[]
  sourcemap: boolean
  ctx: BuildContext
  neverBundle: (string | RegExp)[]
  moduleTsconfig: TsConfigResult | undefined
  isolatedDeclarations: boolean
  selfPaths: Record<string, string[]>
  /** The tsconfig the module entry's declarations are generated with, written by {@link prepareBuild}, or `false` for none. */
  declarationTsconfig: string | false
  /** `paths` the module entry's declarations are generated with. */
  declarationPaths: Record<string, string[]>
  /** `paths` each transpiled directory's declarations are generated with. */
  directoryPaths: Record<string, string[]>
  /** Changes whenever the types Nuxt generates in `.nuxt` change. */
  generatedTypesHash: string
  /** Set by {@link prepareBuild}. */
  prepared?: PreparedBuild
  /** How many times {@link finishBuild} has run. */
  builds: number
  /** Whether {@link finishBuild} writes `types.d.mts`, rather than a bundled entry named `types`. */
  writesTypes?: boolean
}

export interface PreparedBuild {
  /** Bundled entry sources mapped to their output file. */
  bundledSources: Map<string, string>
  /** Sources whose JSX is compiled because Nitro or Node runs them. */
  compiledJsx: Set<string>
  startedAt: number
}

export async function resolveBuild({ cwd, pkg, outDir, sourcemap, loadConfig }: ResolveBuildOptions): Promise<BuildPlan> {
  const runtimeSrcDir = resolve(cwd, 'src/runtime')
  const tsconfigs = await createTsconfigResolver(cwd)
  if (tsconfigs.replaced) {
    const path = relative(cwd, tsconfigs.replaced)
    const advice = path.startsWith('..') ? 'Add a `tsconfig.json` in the module directory that extends `./.nuxt/tsconfig.json`.' : 'Extend `./.nuxt/tsconfig.json` in the module\'s tsconfig.'
    consola.info(`\`${path}\` takes its generated types from another app's \`.nuxt\`; declarations are generated with \`.nuxt/tsconfig.json\` instead. ${advice} ${guide('module-tsconfig')}`)
  }
  const selfPaths = selfReferencePaths(cwd, pkg, outDir)

  const config = await loadConfig()
  if (config.unsupported.length) {
    throw new Error(formatUnsupportedOptions(config.unsupported))
  }
  warnDeprecatedBuildConfig(config)

  const directories: DirectoryEntry[] = [{ srcDir: runtimeSrcDir, outDir: join(outDir, 'runtime'), ext: 'js' }, ...config.directories]
  const resolvedSourcemap = sourcemap || config.sourcemap
  const ctx = createBuildContext({ cwd, outDir, pkg, config, directories, stub: false, sourcemap: resolvedSourcemap })
  const entries = bundledEntries(cwd, config)

  const moduleTsconfig = tsconfigs.resolve(resolve(cwd, entries.module ?? Object.values(entries)[0]!))
  const nuxtDir = findPackageDir('nuxt', cwd)

  return {
    cwd,
    pkg,
    outDir,
    config,
    directories,
    entries,
    runtimeDirs: directories.map(directory => directory.srcDir),
    sourcemap: resolvedSourcemap,
    ctx,
    neverBundle: [...NUXT_EXTERNALS, ...config.neverBundle],
    moduleTsconfig,
    isolatedDeclarations: hasIsolatedDeclarations(moduleTsconfig),
    selfPaths,
    declarationTsconfig: moduleTsconfig ? namedCachePath(cwd, `declarations-${createHash('sha256').update(outDir).digest('hex').slice(0, 12)}.json`) : false,
    // `eager` puts every file of the tsconfig in the program, so ambient declarations such
    // as `.nuxt/nuxt.d.ts` apply and inferred types can be named by their package.
    declarationPaths: declarationPaths({ ...selfPaths, ...tsconfigPaths(moduleTsconfig) }, cwd).paths,
    directoryPaths: { ...selfPaths, ...nuxtDir && { '#app/nuxt': [join(nuxtDir, 'dist/app/nuxt')] } },
    generatedTypesHash: await hashGeneratedTypes(cwd),
    builds: 0,
  }
}

/**
 * Runs `build:before` hooks, checks the module's imports, empties the output directory and
 * writes what declaration generation reads.
 */
export async function prepareBuild(plan: BuildPlan): Promise<PreparedBuild> {
  const { cwd, outDir, entries, runtimeDirs } = plan
  await callBuildHook(plan.config, 'build:before', plan.ctx)
  assertResolvableImports(cwd, Object.values(entries), runtimeDirs)
  await rm(outDir, { recursive: true, force: true })

  await writeServerRoutesStub(cwd)
  if (plan.moduleTsconfig && plan.declarationTsconfig) {
    await writeDerivedTsconfig(cwd, plan.moduleTsconfig, plan.selfPaths, plan.declarationTsconfig)
  }

  const bundledSources = new Map<string, string>()
  for (const [name, input] of Object.entries(entries)) {
    const file = probe(resolve(cwd, input))
    if (file) {
      bundledSources.set(normalize(file), `${name}.mjs`)
    }
  }
  // Nitro and Node do not transform files in `node_modules`, so JSX that runs there is compiled.
  const runtimeFiles = await Promise.all(plan.directories.map(directory => glob(['**/*'], { cwd: directory.srcDir, ignore: DEFAULT_EXCLUDE, absolute: true, onlyFiles: true })))
  const serverFiles = runtimeFiles.flat().map(file => normalize(file)).filter(file => SCRIPT_RE.test(file) && SERVER_DIR_RE.test(relative(cwd, file)))
  const compiledJsx = await valueImports([...serverFiles, ...bundledSources.keys()])

  plan.prepared = { bundledSources, compiledJsx, startedAt: Date.now() }
  return plan.prepared
}

/** Whether a JSX source keeps its JSX for the app to compile. */
export function preservesJsx(plan: BuildPlan, file: string): boolean {
  return !plan.prepared?.compiledJsx.has(normalize(file))
}

/**
 * Where a relative import that resolves outside a transpiled directory points. Bundled
 * entries and other directories keep their own output. Any other file is mirrored where
 * the specifier already points, or under `_external/` when that would take the name of a
 * bundled entry or `types`.
 */
export function resolveDirectoryExternal(plan: BuildPlan, directory: DirectoryEntry): ResolveExternal {
  const { cwd, outDir, directories } = plan
  const reserved = new Set([...Object.keys(plan.entries), 'types'])
  return (_specifier, _importer, { file, kind, from, output }) => {
    const bundled = plan.prepared?.bundledSources.get(file)
    if (bundled) {
      return relativeSpecifier(from, bundled)
    }
    const other = directories.find(directory => !relative(directory.srcDir, file).startsWith('..'))
    if (other) {
      return relativeSpecifier(from, join(relative(outDir, other.outDir), relative(other.srcDir, file).replace(SCRIPT_RE, scriptExtension(file, `.${other.ext}`, preservesJsx(plan, file)))))
    }
    if (reserved.has(output.replace(SCRIPT_RE, ''))) {
      const segments = relative(cwd, file).replace(SCRIPT_RE, scriptExtension(file, `.${directory.ext}`, preservesJsx(plan, file))).split('/').map(segment => segment === '..' ? '_' : segment)
      return { mirror: kind, output: join('_external', ...segments) }
    }
    return { mirror: kind }
  }
}

export interface BuildErrorOptions {
  /** Whether the error comes from a transpiled directory rather than the bundled entries. */
  directory?: boolean
  /** Keeps the previous output, which a watcher goes on serving. */
  keepOutput?: boolean
}

/** Removes a partial output directory and explains declaration failures. */
export async function onBuildError(plan: BuildPlan, error: unknown, { directory = isDirectoryError(error), keepOutput }: BuildErrorOptions = {}): Promise<void> {
  if (!keepOutput) {
    await rm(plan.outDir, { recursive: true, force: true })
  }
  if (plan.isolatedDeclarations && !directory) {
    consola.error(ISOLATED_DECLARATIONS_HINT)
  }
  else if (/\bTS\d{4}\b/.test(String((error as Error | undefined)?.message))) {
    consola.error(TYPE_ERROR_HINT)
  }
}

export interface FinishBuildOptions {
  /** Every file the transpiled directories emitted, relative to the output directory. */
  outputs: string[]
  /** Versions recorded as `builder` in `module.json`, besides this package's. */
  builder: Record<string, string>
}

/** Writes `module.json` and `types.d.mts`, finalises declarations and runs the checks and remaining hooks. */
export async function finishBuild(plan: BuildPlan, { outputs, builder }: FinishBuildOptions): Promise<void> {
  const { cwd, outDir, runtimeDirs, pkg } = plan
  const duration = Date.now() - (plan.prepared?.startedAt ?? Date.now())
  const version = plan.builds++ || undefined
  await writeModuleMeta({
    cwd,
    outDir,
    runtimeDirs,
    pkg,
    builder: { [builderPkg.name]: builderPkg.version, ...builder },
    version,
  }).catch((error) => {
    consola.error(error)
    consola.error('Cannot load module. Please check dist:', resolve(outDir, 'module.mjs'))
  })
  const typesFile = join(outDir, 'types.d.mts')
  plan.writesTypes ??= !existsSync(typesFile)
  if (plan.writesTypes) {
    await rm(typesFile, { force: true })
  }
  await writeTypes(outDir, false)
  await callBuildHook(plan.config, 'rollup:done', plan.ctx)
  await rewriteRuntimeDeclarations(outDir, outputs)

  if (shouldNudge(plan.isolatedDeclarations)) {
    consola.info(`Built in ${duration}ms. Set \`isolatedDeclarations: true\` in your \`tsconfig.json\` to use the faster oxc declaration generator. ${guide('isolated-declarations')}`)
  }

  await checkDeprecatedPackageFields(cwd)
  await callBuildHook(plan.config, 'build:done', plan.ctx)
}

async function valueImports(roots: string[]) {
  const transform = loadOxc()?.transform
  const queue = roots.filter(file => SCRIPT_RE.test(file))
  const found = new Set<string>()
  while (queue.length) {
    const file = queue.pop()!
    if (found.has(file)) {
      continue
    }
    found.add(file)
    const source = await readFile(file, 'utf8')
    const code = transform
      ? (await transform(file, source, { lang: file.match(/\.[cm]?([jt]sx?)$/)![1], jsx: 'preserve', typescript: { onlyRemoveTypeImports: false } })).code
      : source
    for (const specifier of valueSpecifiers(code)) {
      const target = probeSource(resolve(dirname(file), specifier))
      if (target && SCRIPT_RE.test(target)) {
        queue.push(normalize(target))
      }
    }
  }
  return found
}

function isDirectoryError(error: unknown) {
  const errors = (error as { errors?: Array<{ plugin?: string }> } | undefined)?.errors
  return Array.isArray(errors) && errors.some(nested => nested.plugin === 'transpile-dir')
}

function relativeSpecifier(from: string, to: string) {
  const path = relative(dirname(from), to)
  return path.startsWith('.') ? path : `./${path}`
}

/**
 * A hash of the types Nuxt generates in `.nuxt/`, which augment what single-file
 * component declarations refer to without being visible to the declaration cache.
 */
async function hashGeneratedTypes(cwd: string) {
  const files = await glob(['tsconfig.json', '**/*.d.ts'], { cwd: join(cwd, '.nuxt'), absolute: true, onlyFiles: true })
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(relative(cwd, file)).update(await readFile(file))
  }
  return hash.digest('hex').slice(0, 12)
}
