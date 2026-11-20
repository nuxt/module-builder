import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve } from 'pathe'
import type { NuxtModule } from '@nuxt/schema'
import { Diagnostic } from 'nostics'
import type { TsConfigResult } from 'get-tsconfig'
import { glob, globSync } from 'tinyglobby'

import builderPkg from '../../package.json' with { type: 'json' }
import { scriptExtension, valueSpecifiers } from '../transpile/specifiers.ts'
import { EXCLUDE } from '../transpile/transpile-dir.ts'
import type { ResolveExternal } from '../transpile/transpile-dir.ts'
import { createTsconfigResolver, declarationPaths, hasIsolatedDeclarations, namedCachePath, TsconfigError, tsconfigPaths, writeDependencyImports, writeDerivedTsconfig, writeServerRoutesStub } from '../transpile/tsconfig.ts'
import type { TsconfigResolver } from '../transpile/tsconfig.ts'
import { errors, warnings } from '../diagnostics.ts'
import { findPackageDir, findUp, isInside, isSourceScript, probe, relativeSpecifier, SCRIPT_RE, writeIfChanged } from '../utils.ts'
import type { PackageJson } from '../utils.ts'
import { rewriteRuntimeDeclarations } from './aliases.ts'
import { assertLoadableModuleCode, importModule, loadOxc } from './loader.ts'
import { bundledEntries, NUXT_EXTERNALS } from './options.ts'
import type { DirectoryEntry, ModuleConfig } from './options.ts'
import { checkPublishedPaths, importsKeyFor, publishedPackage, selfReferencePaths, unpublishableImportsError } from './package.ts'
import { writeTypes } from './types.ts'

const SERVER_DIR_RE = /(?:^|\/)server\//

/** Everything a build needs to know about the module, resolved before anything is written. */
export interface BuildPlan {
  cwd: string
  pkg: PackageJson
  /** Absolute path of the output directory, already checked with `resolveOutDir`. */
  outDir: string
  config: ModuleConfig
  /** `src/runtime` and every other directory transpiled file by file. */
  directories: DirectoryEntry[]
  /** Bundled entries keyed by output name, as paths relative to `cwd`. */
  entries: { module: string, [name: string]: string }
  runtimeDirs: string[]
  sourcemap: boolean
  neverBundle: (string | RegExp)[]
  moduleTsconfig: TsConfigResult | undefined
  /** The nearest tsconfig, which may delegate files to `references`. */
  rootTsconfig: TsConfigResult | undefined
  /** The referenced project that includes the module entry, which the bundler reads in place of a root tsconfig that only lists references. */
  moduleProject?: string
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
}

export interface PreparedBuild {
  /** Bundled entry sources mapped to their output file. */
  bundledSources: Map<string, string>
  /** Sources whose JSX is compiled because Nitro or Node runs them. */
  compiledJsx: Set<string>
}

/** The tsconfigs of the module in `cwd`, see `createTsconfigResolver`. A tsconfig that cannot be read fails with a diagnostic. */
export async function moduleTsconfigs(cwd: string): Promise<TsconfigResolver> {
  return createTsconfigResolver(cwd).catch((error: unknown) => {
    throw error instanceof TsconfigError
      ? errors.NUXT_MB_C0302({ path: relative(cwd, error.path), reason: error.message, tsconfig: error.referenced ? 'referenced' : isInside(cwd, error.path) ? 'own' : 'parent', cause: error, sources: [error.path] })
      : error
  })
}

export async function resolveBuild({ cwd, pkg, outDir, sourcemap, config }: Pick<BuildPlan, 'cwd' | 'pkg' | 'outDir' | 'sourcemap' | 'config'>): Promise<BuildPlan> {
  const tsconfigs = await moduleTsconfigs(cwd)
  if (tsconfigs.replaced) {
    const sources = [tsconfigs.replaced, ...['.nuxt/tsconfig.json', ...['node', 'app', 'server', 'shared'].map(part => `.nuxt/tsconfig.${part}.json`)].map(file => resolve(cwd, file))]
    warnings.NUXT_MB_C0301({ path: relative(cwd, tsconfigs.replaced), inside: isInside(cwd, tsconfigs.replaced), sources }, { method: 'info' })
  }

  const directories: DirectoryEntry[] = [{ srcDir: resolve(cwd, 'src/runtime'), outDir: join(outDir, 'runtime'), ext: 'js' }, ...config.directories]
  const entries = bundledEntries(cwd, config)
  const selfPaths = selfReferencePaths(cwd, pkg, outDir, entries)

  const moduleTsconfig = tsconfigs.resolve(resolve(cwd, entries.module))
  const nuxtDir = findPackageDir('nuxt', cwd)

  return {
    cwd,
    pkg,
    outDir,
    config,
    directories,
    entries,
    runtimeDirs: directories.map(directory => directory.srcDir),
    sourcemap: sourcemap || !!config.sourcemap,
    neverBundle: [...NUXT_EXTERNALS, ...config.neverBundle],
    moduleTsconfig,
    rootTsconfig: tsconfigs.root,
    ...moduleTsconfig && moduleTsconfig.path !== tsconfigs.root?.path && !tsconfigs.replaced && { moduleProject: moduleTsconfig.path },
    isolatedDeclarations: config.isolatedDeclarations ?? hasIsolatedDeclarations(moduleTsconfig),
    selfPaths,
    declarationTsconfig: moduleTsconfig ? namedCachePath(cwd, `declarations-${createHash('sha256').update(outDir).digest('hex').slice(0, 12)}.json`) : false,
    declarationPaths: declarationPaths({ ...selfPaths, ...tsconfigPaths(moduleTsconfig) }, cwd).paths,
    directoryPaths: { ...selfPaths, ...nuxtDir && { '#app/nuxt': [join(nuxtDir, 'dist/app/nuxt')] } },
    generatedTypesHash: await hashGeneratedTypes(cwd),
  }
}

/**
 * Runs `build:before` hooks, checks the module's imports, empties the output directory unless
 * `keepOutput` is set, and writes what declaration generation reads.
 */
export async function prepareBuild(plan: BuildPlan, { keepOutput }: { keepOutput: boolean }): Promise<void> {
  const { cwd, outDir, entries, runtimeDirs } = plan
  await plan.config.callHook?.('build:before', plan)
  assertLoadableModuleCode(cwd, [entries.module], runtimeDirs, Object.values(entries))
  if (!keepOutput) {
    await rm(outDir, { recursive: true, force: true })
  }

  await writeServerRoutesStub(cwd)
  if (plan.moduleTsconfig && plan.declarationTsconfig) {
    const imports = plan.moduleProject ? await writeDependencyImports(cwd, plan.rootTsconfig) : undefined
    await writeDerivedTsconfig(cwd, plan.moduleTsconfig, plan.selfPaths, { file: plan.declarationTsconfig, imports })
  }
  plan.prepared = analyseSources(plan)
}

/**
 * Finds the bundled sources and the runtime files whose JSX is compiled, for the build about
 * to start. Rebuilds under watch call it again, as files may have been added.
 */
export function analyseSources(plan: BuildPlan): PreparedBuild {
  const { cwd, entries } = plan
  const bundledSources = new Map(Object.entries(entries).flatMap(([name, input]) => {
    const file = probe(resolve(cwd, input))
    return file ? [[normalize(file), `${name}.mjs`] as const] : []
  }))
  // Nitro and Node do not transform files in `node_modules`, so JSX that runs there is compiled.
  const serverFiles = plan.directories.flatMap(directory => globSync(['**/*'], { cwd: directory.srcDir, ignore: EXCLUDE, absolute: true, onlyFiles: true }))
    .map(file => normalize(file))
    .filter(file => SCRIPT_RE.test(file) && SERVER_DIR_RE.test(relative(cwd, file)))
  const compiledJsx = valueImports([...serverFiles, ...bundledSources.keys()])
  return { bundledSources, compiledJsx }
}

/** Whether a JSX source keeps its JSX for the app to compile. */
export function preservesJsx(plan: BuildPlan, file: string): boolean {
  return !plan.prepared?.compiledJsx.has(normalize(file))
}

/**
 * Where a relative import that resolves outside a transpiled directory points. Bundled
 * entries and other directories keep their own output. Any other file is mirrored.
 */
export function resolveDirectoryExternal(plan: BuildPlan): ResolveExternal {
  const { outDir, directories } = plan
  return (_specifier, _importer, { file, kind, from }) => {
    const bundled = plan.prepared?.bundledSources.get(file)
    if (bundled) {
      return relativeSpecifier(from, bundled)
    }
    const other = directories.find(directory => isInside(directory.srcDir, file))
    if (other) {
      return relativeSpecifier(from, join(relative(outDir, other.outDir), relative(other.srcDir, file).replace(SCRIPT_RE, scriptExtension(file, `.${other.ext}`, preservesJsx(plan, file)))))
    }
    return { mirror: kind }
  }
}

export interface BuildErrorOptions {
  /** Whether the error comes from a transpiled directory rather than the bundled entries. */
  directory?: boolean
  /** Keeps the previous output, which a watcher goes on serving. */
  keepOutput: boolean
}

/** Removes a partial output directory and explains declaration failures. */
export async function onBuildError(plan: BuildPlan, error: unknown, { directory = isDirectoryError(plan, error), keepOutput }: BuildErrorOptions): Promise<void> {
  if (!keepOutput) {
    await rm(plan.outDir, { recursive: true, force: true })
  }
  if (error instanceof Diagnostic) {
    return
  }
  if (plan.isolatedDeclarations && !directory) {
    warnings.NUXT_MB_B0202({ setting: plan.config?.isolatedDeclarations ? '`declarations.isolated`' : 'the tsconfig\'s `isolatedDeclarations`' }, { method: 'error' })
  }
  else if (/\bTS\d{4}\b/.test(String((error as Error | undefined)?.message))) {
    warnings.NUXT_MB_B0203(undefined, { method: 'error' })
  }
}

export interface FinishBuildOptions {
  /** Every file the transpiled directories emitted, relative to the output directory. */
  outputs: string[]
  /** Versions recorded as `builder` in `module.json`, besides this package's. */
  builder: Record<string, string>
  /** Keeps the output when a step or check fails, as a watcher goes on serving it. */
  keepOutput?: boolean
}

// Counted per process, as a restarted watcher imports the same files again with a new plan.
let metaImports = 0

/** Writes `module.json` and `types.d.mts`, finalises declarations and runs the checks and remaining hooks. */
export async function finishBuild(plan: BuildPlan, { outputs, builder, keepOutput }: FinishBuildOptions): Promise<void> {
  const { cwd, outDir, pkg } = plan
  try {
    const types = outputs.find(file => file === 'types.mjs' || file === 'types.d.mts')
    if (types) {
      throw errors.NUXT_MB_C0011({ file: types, outDir: relative(cwd, outDir), sources: [outDir] })
    }
    const moduleFile = resolve(outDir, 'module.mjs')
    const meta = await importModule(moduleFile, { cwd, version: metaImports++ || undefined })
      .then(exports => ((exports.default ?? exports) as NuxtModule<Record<string, unknown>>).getMeta?.())
      .then(meta => meta || {}, (error) => {
        throw errors.NUXT_MB_B0002({ file: relative(cwd, moduleFile), reason: error instanceof Error ? error.message : String(error), cause: error, sources: [moduleFile] })
      })
    meta.name ||= pkg.name
    meta.version ||= pkg.version
    meta.builder = { [builderPkg.name]: builderPkg.version, ...builder }
    await writeIfChanged(resolve(outDir, 'module.json'), JSON.stringify(meta, null, 2))
    await writeTypes(outDir)
    await plan.config.callHook?.('rollup:done', plan)
    await rewriteRuntimeDeclarations(outDir, outputs)

    await checkPublishedPaths(cwd)
    const importsError = unpublishableImportsError(cwd, pkg, importedFrom(outDir, Object.keys(publishedPackage(pkg).imports ?? {})))
    if (importsError) {
      throw importsError
    }
    await plan.config.callHook?.('build:done', plan)
  }
  catch (error) {
    if (!keepOutput) {
      await rm(outDir, { recursive: true, force: true })
    }
    throw error
  }
}

const OUTPUT_TEXT_RE = /\.(?:[cm]?[jt]sx?|vue|css)$/

const PACKAGE_IMPORT_RE = /(?:\bfrom|\bimport(?:\s+url)?|\brequire)\s*(?:\(\s*)?(["'`])(#[^"'`]+)\1/g

function importedFrom(dir: string, keys: string[]): (key: string) => boolean {
  let used: Set<string | undefined> | undefined
  return (key) => {
    used ??= new Set(readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(file => OUTPUT_TEXT_RE.test(file))
      .flatMap(file => [...readFileSync(join(dir, file), 'utf8').matchAll(PACKAGE_IMPORT_RE)].map(match => importsKeyFor(keys, match[2]!))))
    return used.has(key)
  }
}

function valueImports(roots: string[]) {
  const { transformSync } = loadOxc()!
  const queue = roots.filter(isSourceScript)
  const found = new Set<string>()
  while (queue.length) {
    const file = queue.pop()!
    if (found.has(file)) {
      continue
    }
    found.add(file)
    const { code } = transformSync(file, readFileSync(file, 'utf8'), { lang: file.match(/\.[cm]?([jt]sx?)$/)![1], jsx: 'preserve', typescript: { onlyRemoveTypeImports: false } })
    for (const specifier of valueSpecifiers(code, file)) {
      const target = probe(resolve(dirname(file), specifier))
      if (target && isSourceScript(target)) {
        queue.push(normalize(target))
      }
    }
  }
  return found
}

/** The name of the plugin that transpiles `directory`, which rolldown prints with its errors. */
export function directoryPluginName(plan: BuildPlan, directory: DirectoryEntry): string {
  return `nuxt-module-builder:${relative(plan.cwd, directory.srcDir)}`
}

function isDirectoryError(plan: BuildPlan, error: unknown) {
  const names = new Set(plan.directories.map(directory => directoryPluginName(plan, directory)))
  const errors = (error as { errors?: Array<{ plugin?: string }> } | undefined)?.errors
  return Array.isArray(errors) && errors.some(nested => nested.plugin !== undefined && names.has(nested.plugin))
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']

/**
 * A hash of the types Nuxt generates in `.nuxt/` and of the nearest lockfile, which change
 * what single-file component declarations refer to without being visible to the declaration cache.
 */
export async function hashGeneratedTypes(cwd: string): Promise<string> {
  const files = await glob(['tsconfig.json', '**/*.d.ts'], { cwd: join(cwd, '.nuxt'), absolute: true, onlyFiles: true })
  const lockfile = findUp(cwd, dir => LOCKFILES.map(name => join(dir, name)).find(file => existsSync(file)))
  const hash = createHash('sha256')
  for (const file of [...files.sort(), ...lockfile ? [lockfile] : []]) {
    hash.update(relative(cwd, file)).update(await readFile(file))
  }
  return hash.digest('hex').slice(0, 12)
}
