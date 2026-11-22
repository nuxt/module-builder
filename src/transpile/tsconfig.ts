import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createFilesMatcher, createPathsMatcher, getTsconfig, parseTsconfig } from 'get-tsconfig'
import type { TsConfigResult } from 'get-tsconfig'
import { dirname, join, relative, resolve } from 'pathe'
import type ts from 'typescript'

import { findPackageDir, findUp, getOrCreate, isInside, NODE_MODULES_RE } from '../utils.ts'
import { moduleSpecifiers } from './specifiers.ts'

export interface TsconfigResolver {
  /** The nearest tsconfig, which may delegate files to `references`. */
  root: TsConfigResult | undefined
  /** The tsconfig a source file is compiled with. */
  resolve: (file: string) => TsConfigResult | undefined
  /** The tsconfig found above `dir` when it took its generated types from another app's `.nuxt`, which `.nuxt/tsconfig.json` replaces in `root`. */
  replaced?: string
}

/**
 * Finds the nearest tsconfig above `dir`. When it has `references`, each
 * source file is compiled with the referenced project that includes it, falling back to
 * the tsconfig itself. A tsconfig whose generated types come from a `.nuxt` other than
 * `dir`'s own (a playground's, typically) is rebuilt on `dir/.nuxt/tsconfig.json`, see
 * {@link rebaseOnOwnBuildDir}.
 */
export async function createTsconfigResolver(dir: string): Promise<TsconfigResolver> {
  let root: TsConfigResult | undefined
  try {
    root = getTsconfig(dir) ?? undefined
  }
  catch (error) {
    throw new TsconfigError(findUp(dir, ancestor => existsSync(join(ancestor, 'tsconfig.json')) ? join(ancestor, 'tsconfig.json') : undefined) ?? join(dir, 'tsconfig.json'), error)
  }
  let replaced: string | undefined
  const own = join(dir, '.nuxt/tsconfig.json')
  if (root && usesForeignBuildDir(root, dir) && existsSync(own)) {
    replaced = root.path
    root = await rebaseOnOwnBuildDir(root.path, own, dir)
  }
  const projects = allReferencedProjects(root).map(project => ({ project, matches: createFilesMatcher(project) }))
  return {
    root,
    resolve: file => projects.find(({ matches }) => matches(file.endsWith('.vue') ? `${file}.ts` : file))?.project ?? root,
    ...replaced && { replaced },
  }
}

/** The file system that `@vue/compiler-sfc` resolves the types of script setup macros through. */
export interface TypeResolutionFs {
  fileExists: (file: string) => boolean
  readFile: (file: string) => string | undefined
  realpath?: (file: string) => string
}

/** The contents given to each virtual `tsconfig.json` in this process, which `@vue/compiler-sfc` caches by path. */
const presented = new Map<string, string>()

/**
 * A file system for each of `files` with a `tsconfig.json` holding the merged `compilerOptions`
 * of its `project`, paths made absolute, in its directory or the closest one above that no file
 * of another project uses and that has not held other contents. The `tsconfig.json` files below
 * that one are hidden.
 */
export async function typeResolutionFs(files: string[], project: (file: string) => TsConfigResult | undefined): Promise<Map<string, TypeResolutionFs>> {
  const { default: ts } = await import('typescript')
  const configs = new Map<string, Promise<string>>()
  const owners = new Map<string, string>()
  const result = new Map<string, TypeResolutionFs>()
  for (const file of files) {
    const tsconfig = project(file)
    if (!tsconfig) {
      continue
    }
    const contents = await getOrCreate(configs, tsconfig.path, async () => JSON.stringify({ compilerOptions: (await inheritedTsconfig(tsconfig.path, () => false)).compilerOptions }))
    const taken = (path: string) => (owners.get(path) ?? tsconfig.path) !== tsconfig.path || (presented.get(path) ?? contents) !== contents
    const hidden = new Set<string>()
    let path = join(dirname(file), 'tsconfig.json')
    while (taken(path) && dirname(dirname(path)) !== dirname(path)) {
      hidden.add(path)
      path = join(dirname(dirname(path)), 'tsconfig.json')
    }
    if (taken(path)) {
      continue
    }
    owners.set(path, tsconfig.path)
    presented.set(path, contents)
    result.set(file, {
      fileExists: name => name === path || (!hidden.has(name) && ts.sys.fileExists(name)),
      readFile: name => name === path ? contents : hidden.has(name) ? undefined : ts.sys.readFile(name),
      realpath: ts.sys.realpath,
    })
  }
  return result
}

/** The error for a tsconfig that cannot be read, such as one that extends a file that does not exist. */
export class TsconfigError extends Error {
  /** The tsconfig that cannot be read. */
  readonly path: string
  /** Whether another tsconfig references it, rather than it being the nearest one. */
  readonly referenced: boolean
  constructor(path: string, cause: unknown, referenced = false) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.path = path
    this.referenced = referenced
  }
}

function usesForeignBuildDir(tsconfig: TsConfigResult, dir: string) {
  const targets = Object.values(tsconfigPaths(tsconfig)).flat()
  const projects = allReferencedProjects(tsconfig).map(project => project.path)
  return [...targets, ...projects].some(file => isForeignBuildFile(file, dir))
}

function isOwnBuildFile(file: string, dir: string) {
  return isInside(join(dir, '.nuxt'), file)
}

function isForeignBuildFile(file: string, dir: string) {
  return NUXT_BUILD_DIR_RE.test(file) && !isOwnBuildFile(file, dir)
}

/** The package a bare specifier names, or `undefined` for a path, an alias or a specifier with a protocol. */
export function packageName(specifier: string): string | undefined {
  return /^(?:[#./]|[~@]\/)/.test(specifier) || specifier.includes(':') ? undefined : specifier.match(PACKAGE_NAME_RE)?.[0]
}

function parseProject(ts: typeof import('typescript'), path: string, vue: boolean) {
  const extraFileExtensions = vue ? [{ extension: 'vue', isMixedContent: true, scriptKind: ts.ScriptKind.Deferred }] : undefined
  return ts.getParsedCommandLineOfConfigFile(path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }, undefined, undefined, extraFileExtensions)
}

const PATH_OPTIONS = ['baseUrl', 'rootDir', 'outDir', 'declarationDir', 'tsBuildInfoFile'] as const
const PATH_LIST_OPTIONS = ['rootDirs', 'typeRoots'] as const

/**
 * Writes a tsconfig that extends `own` with the `compilerOptions` of `tsconfig` and of the
 * tsconfigs it extends, apart from those inside a `.nuxt` other than `dir`'s. `types` are the
 * union of both, `paths` into another `.nuxt` are dropped and `own`'s win on conflicts, and
 * `references` into another `.nuxt` are dropped.
 */
async function rebaseOnOwnBuildDir(tsconfig: string, own: string, dir: string): Promise<TsConfigResult> {
  const { default: ts } = await import('typescript')
  const ownConfig = parseTsconfig(own)
  const ownPaths = tsconfigPaths({ path: own, config: ownConfig })
  const { paths, types, ...options } = (await inheritedTsconfig(tsconfig, target => isForeignBuildFile(target, dir))).compilerOptions
  const ownTypes = ownConfig.compilerOptions?.types
  const config = {
    extends: own,
    compilerOptions: {
      ...options,
      paths: { ...Object.fromEntries(Object.entries((paths ?? {}) as Record<string, string[]>).filter(([, targets]) => !targets.some(target => isForeignBuildFile(target, dir)))), ...ownPaths },
      ...(ownTypes || types) ? { types: [...new Set([...ownTypes ?? [], ...(types ?? []) as string[]])] } : {},
    },
  }
  const references = ((ts.readConfigFile(tsconfig, ts.sys.readFile).config as RawTsconfig | undefined)?.references ?? [])
    .map(reference => ({ path: resolve(dirname(tsconfig), reference.path) }))
    .filter(reference => !isForeignBuildFile(reference.path, dir))
  const file = await writeCached(dir, '.json', JSON.stringify({ ...config, ...references.length && { references } }))
  return { path: file, config: parseTsconfig(file) }
}

interface RawTsconfig {
  extends?: string | string[]
  compilerOptions?: Record<string, unknown>
  exclude?: string[]
  references?: { path: string }[]
}

interface InheritedTsconfig {
  compilerOptions: Record<string, unknown>
  /** Absolute patterns. */
  exclude?: string[]
  /** Whether the tsconfig itself has `references`, rather than one it extends. */
  references?: boolean
}

/** The `compilerOptions` and `exclude` of `dir/tsconfig.json`, see {@link inheritedTsconfig}, apart from those of tsconfigs in a `.nuxt`, and whether it has `references`. */
export async function rootTsconfig(dir: string): Promise<InheritedTsconfig> {
  const { default: ts } = await import('typescript')
  const file = join(dir, 'tsconfig.json')
  const raw = ts.readConfigFile(file, ts.sys.readFile).config as RawTsconfig | undefined
  return { ...await inheritedTsconfig(file, target => NUXT_BUILD_DIR_RE.test(target)), references: !!raw?.references?.length }
}

/**
 * The `compilerOptions` and `exclude` of `file` and of the tsconfigs it extends, apart from
 * those `skip` matches, merged as TypeScript merges them, with paths made absolute. `paths`
 * resolve against the merged `baseUrl`, or else the directory of the tsconfig that sets them.
 */
async function inheritedTsconfig(file: string, skip: (file: string) => boolean): Promise<InheritedTsconfig> {
  const { default: ts } = await import('typescript')
  const configDir = dirname(file)
  const layer = (path: string, ancestors: string[]): InheritedTsconfig & { pathsBase?: string } => {
    const raw = ts.readConfigFile(path, ts.sys.readFile).config as RawTsconfig | undefined
    const bases = [raw?.extends ?? []].flat()
      .map(target => resolveExtends(ts, target, dirname(path)))
      .filter((target): target is string => target !== undefined && !ancestors.includes(target) && !skip(target))
      .map(target => layer(target, [...ancestors, path]))
    return {
      compilerOptions: Object.assign({}, ...bases.map(base => base.compilerOptions), absoluteOptions(raw?.compilerOptions ?? {}, dirname(path), configDir)),
      exclude: raw?.exclude?.map(pattern => resolve(dirname(path), pattern.replace('${configDir}', configDir))) ?? bases.findLast(base => base.exclude)?.exclude,
      pathsBase: raw?.compilerOptions?.paths ? dirname(path) : bases.findLast(base => base.pathsBase)?.pathsBase,
    }
  }
  const { pathsBase, ...result } = layer(file, [])
  const { paths, baseUrl } = result.compilerOptions
  if (paths && typeof paths === 'object') {
    const base = typeof baseUrl === 'string' ? baseUrl : pathsBase!
    result.compilerOptions.paths = Object.fromEntries(Object.entries(paths as Record<string, string[]>).map(([alias, targets]) => [alias, targets.map(target => resolve(base, target))]))
  }
  return result
}

const RELATIVE_RE = /^\.\.?[\\/]/

/** The existing tsconfig that an `extends` entry in a tsconfig in `from` names, resolved by TypeScript. */
function resolveExtends(ts: typeof import('typescript'), target: string, from: string) {
  const file = join(from, 'tsconfig.json')
  const source = ts.readJsonConfigFile(file, () => JSON.stringify({ extends: target, files: [], include: [] }))
  ts.parseJsonSourceFileConfigFileContent(source, { ...ts.sys, readDirectory: () => [] }, from, undefined, file)
  return source.extendedSourceFiles?.[0]
}

/** Path options resolved against `from`, the layer's directory; `${configDir}` and relative `types` are the leaf tsconfig's. `paths` are resolved once merged. */
function absoluteOptions(options: Record<string, unknown>, from: string, configDir: string) {
  const dir = (value: string) => resolve(from, value.replace('${configDir}', configDir))
  const result = { ...options }
  for (const key of PATH_OPTIONS) {
    if (typeof result[key] === 'string') {
      result[key] = dir(result[key])
    }
  }
  for (const key of PATH_LIST_OPTIONS) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].map(value => dir(value as string))
    }
  }
  if (Array.isArray(result.types)) {
    result.types = result.types.map(value => typeof value === 'string' && (RELATIVE_RE.test(value) || value.includes('${configDir}')) ? resolve(configDir, value.replace('${configDir}', configDir)) : value)
  }
  if (result.paths && typeof result.paths === 'object') {
    result.paths = Object.fromEntries(Object.entries(result.paths as Record<string, string[]>).map(([alias, targets]) => [alias, targets.map(target => target.replace('${configDir}', configDir))]))
  }
  return result
}

const FOREIGN_DIR_RE = /^(?:playgrounds?(?:-.*)?|docs|tests?|fixtures|examples?|node_modules)$/

/**
 * The files of a parsed tsconfig that belong to the module in `dir`: inside `dir`, outside
 * its playground, docs, test, fixture and example directories, and not generated for
 * another app.
 */
function projectFiles(parsed: ts.ParsedCommandLine | undefined, dir: string): string[] {
  return (parsed?.fileNames ?? []).filter(file => isModuleFile(file, dir))
}

/** Whether `file` belongs to the module in `dir`, as {@link projectFiles} decides. */
export function isModuleFile(file: string, dir: string): boolean {
  return isInside(dir, file) && !FOREIGN_DIR_RE.test(relative(dir, file).split('/')[0]!) && !NODE_MODULES_RE.test(file) && !isForeignBuildFile(file, dir)
}

/**
 * The projects `tsconfig` references, with the module's own tsconfigs before those Nuxt
 * generates and, of those, the app's last, as its files include the others'.
 */
function referencedProjects(tsconfig: TsConfigResult | undefined): TsConfigResult[] {
  return (tsconfig?.config.references ?? []).flatMap((reference) => {
    const path = resolve(dirname(tsconfig!.path), reference.path)
    const config = path.endsWith('.json') ? path : join(path, 'tsconfig.json')
    if (!existsSync(config)) {
      return []
    }
    try {
      return [{ path: config, config: parseTsconfig(config) }]
    }
    catch (error) {
      throw new TsconfigError(config, error, true)
    }
  }).sort((a, b) => projectRank(a.path) - projectRank(b.path))
}

function projectRank(path: string) {
  if (!NUXT_BUILD_DIR_RE.test(path)) {
    return 0
  }
  return /[\\/]tsconfig(?:\.app)?\.json$/.test(path) ? 2 : 1
}

function allReferencedProjects(tsconfig: TsConfigResult | undefined, seen = new Set<string>()): TsConfigResult[] {
  return referencedProjects(tsconfig).flatMap((project) => {
    if (seen.has(project.path)) {
      return []
    }
    seen.add(project.path)
    return [project, ...allReferencedProjects(project, seen)]
  }).sort((a, b) => projectRank(a.path) - projectRank(b.path))
}

export function hasIsolatedDeclarations(tsconfig: TsConfigResult | undefined): boolean {
  return tsconfig?.config.compilerOptions?.isolatedDeclarations === true
}

/** The tsconfig's `paths` made absolute. */
export function tsconfigPaths(tsconfig: TsConfigResult | undefined): Record<string, string[]> {
  const paths = tsconfig?.config.compilerOptions?.paths
  const matchPath = paths && createPathsMatcher(tsconfig!)
  return matchPath ? Object.fromEntries(Object.keys(paths).map(alias => [alias, matchPath(alias)])) : {}
}

const BUILD_ALIAS_RE = /^#(?:build|internal)(?:\/|$)/
const SERVER_ROUTES_ALIAS = '#build/server-routes'
const NUXT_BUILD_DIR_RE = /[\\/]\.nuxt(?:[\\/]|$)/
const PACKAGE_NAME_RE = /^(?:@[\w.-]+\/)?[\w.-]+/

export interface DeclarationPaths {
  paths: Record<string, string[]>
  /** Aliases left to an ambient `declare module`, so their imports are typed `any`. */
  ambient: string[]
}

/**
 * The `paths` declarations are generated with. Aliases of files generated for the
 * local app (`#build/*`, `#internal/*` and anything else inside `.nuxt/`, apart from
 * `#imports`) are not followed, so published types do not depend on it. `#build/server-routes`,
 * which Nuxt's own fetch types import, maps to the module's own route table (which types
 * the routes the module registers) or, without one, to {@link SERVER_ROUTES_STUB}. Entries
 * mapping an installed package into `node_modules` are dropped, so tsc names it by its package.
 */
export function declarationPaths(paths: Record<string, string[]>, cwd: string): DeclarationPaths {
  const result: DeclarationPaths = { paths: { [SERVER_ROUTES_ALIAS]: [serverRoutesTable(paths, cwd) ?? cachedPath(cwd, '.d.ts', SERVER_ROUTES_STUB)] }, ambient: [] }
  for (const [alias, targets] of Object.entries(paths)) {
    if (alias === SERVER_ROUTES_ALIAS) {
      continue
    }
    if (BUILD_ALIAS_RE.test(alias) || (alias.startsWith('#') && alias !== '#imports' && targets.some(target => NUXT_BUILD_DIR_RE.test(target)))) {
      result.ambient.push(alias)
      continue
    }
    const name = packageName(alias)
    if (name && targets.every(target => NODE_MODULES_RE.test(target)) && findPackageDir(name, cwd)) {
      continue
    }
    result.paths[alias] = targets
  }
  return result
}

function serverRoutesTable(paths: Record<string, string[]>, cwd: string) {
  return [...paths[SERVER_ROUTES_ALIAS] ?? [], ...(paths['#build/*'] ?? []).map(target => target.replaceAll('*', 'server-routes'))]
    .map(target => target.endsWith('.d.ts') ? target : `${target}.d.ts`)
    .find(file => isOwnBuildFile(file, cwd) && existsSync(file))
}

const cacheDir = (cwd: string) => join(cwd, 'node_modules/.cache/transpile-dir')

function cachedPath(cwd: string, extension: string, contents: string) {
  return join(cacheDir(cwd), `${createHash('sha256').update(contents).digest('hex').slice(0, 12)}${extension}`)
}

/**
 * Writes `contents` to its content-addressed path unless it is already there, through a
 * temporary file, so a concurrent reader (the declaration worker) never sees it half-written.
 */
async function writeCached(cwd: string, extension: string, contents: string) {
  const file = cachedPath(cwd, extension, contents)
  return existsSync(file) ? file : writeAtomic(file, contents)
}

/** A path in the cache directory that keeps its name whatever is written to it. */
export function namedCachePath(cwd: string, name: string): string {
  return join(cacheDir(cwd), name)
}

async function writeAtomic(file: string, contents: string) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}`
  await writeFile(temp, contents)
  await rename(temp, file).catch(async (error) => {
    if (!existsSync(file)) {
      throw error
    }
    await rm(temp, { force: true })
  })
  return file
}

/**
 * The {@link declarationPaths} of the `paths` of `tsconfig` plus `paths`, once the files they
 * rely on are written: the server routes stub, and the `ambient` file that declares each alias
 * left out as a module.
 */
export async function writeDeclarationPaths(cwd: string, tsconfig: TsConfigResult | undefined, paths: Record<string, string[]>): Promise<{ paths: Record<string, string[]>, ambient?: string }> {
  const declaration = declarationPaths({ ...tsconfigPaths(tsconfig), ...paths }, cwd)
  await writeServerRoutesStub(cwd)
  return {
    paths: declaration.paths,
    ...declaration.ambient.length && { ambient: await writeCached(cwd, '.d.ts', declaration.ambient.map(alias => `declare module '${alias}'\n`).join('')) },
  }
}

/**
 * The module `#build/server-routes` resolves to while declarations are generated when the
 * module's `.nuxt` has no route table: the one Nuxt generates for an app without server
 * routes, so a `useFetch` or `$fetch` response is typed `unknown`.
 */
export const SERVER_ROUTES_STUB = `import type { AnyHTTPMethod, TypedFetchErrorBody, TypedFetchMethods, TypedFetchRequestBody, TypedFetchRequestHeaders, TypedFetchRequestQuery, TypedFetchRequires, TypedFetchResponseBody, TypedFetchResponseHeaders, ValidFetchInput } from 'nuxt/app'

export interface GeneratedServerRoutes {}

export type Path = never

export type ValidInput<Path_, Method extends AnyHTTPMethod = 'GET'> = ValidFetchInput<GeneratedServerRoutes, Path_, Method>

export type Response<Path_, Method extends AnyHTTPMethod = 'GET'> = TypedFetchResponseBody<GeneratedServerRoutes, Path_, Method>

export type Methods<Path_> = TypedFetchMethods<GeneratedServerRoutes, Path_>

export type ResponseHeaders<Path_, Method extends AnyHTTPMethod = 'GET'> = TypedFetchResponseHeaders<GeneratedServerRoutes, Path_, Method>

export type ErrorBody<Path_, Method extends AnyHTTPMethod = 'GET'> = TypedFetchErrorBody<GeneratedServerRoutes, Path_, Method>

export type RequestBody<Path_, Method extends AnyHTTPMethod = 'GET', Fallback = BodyInit | null> = TypedFetchRequestBody<GeneratedServerRoutes, Path_, Method, Fallback>

export type RequestQuery<Path_, Method extends AnyHTTPMethod = 'GET', Fallback = Record<string, unknown>> = TypedFetchRequestQuery<GeneratedServerRoutes, Path_, Method, Fallback>

export type RequestHeaders<Path_, Method extends AnyHTTPMethod = 'GET', Fallback = HeadersInit> = TypedFetchRequestHeaders<GeneratedServerRoutes, Path_, Method, Fallback>

export type Requires<Path_, Method extends AnyHTTPMethod, Field extends 'body' | 'query' | 'headers'> = TypedFetchRequires<GeneratedServerRoutes, Path_, Method, Field>

export type StrictFetchPaths = false

export type RouteTypesEngine = 'generated'
`

/** Writes {@link SERVER_ROUTES_STUB} where {@link declarationPaths} maps `#build/server-routes`. */
export function writeServerRoutesStub(cwd: string): Promise<string> {
  return writeCached(cwd, '.d.ts', SERVER_ROUTES_STUB)
}

/**
 * Writes a declaration file that imports each installed package the files of the projects
 * `tsconfig` references import, one specifier per package, or returns `undefined` when it has
 * no references. A program over one of those projects that lists it resolves the module's
 * dependencies from the module root, so their types are named by package in declarations.
 */
export async function writeDependencyImports(cwd: string, tsconfig: TsConfigResult | undefined): Promise<string | undefined> {
  const projects = allReferencedProjects(tsconfig)
  if (!projects.length) {
    return
  }
  const { default: ts } = await import('typescript')
  const files = new Set(projects.flatMap(project => projectFiles(parseProject(ts, project.path, true), cwd)))
  const sources = await Promise.all([...files].sort().map(async file => ({ file, source: await readFile(file, 'utf8').catch(() => '') })))
  const specifiers = new Map<string, string>()
  for (const { file, source } of sources) {
    for (const { specifier } of moduleSpecifiers(source, file)) {
      const name = packageName(specifier)
      if (name && !specifiers.has(name) && findPackageDir(name, cwd)) {
        specifiers.set(name, specifier)
      }
    }
  }
  return writeCached(cwd, '.d.ts', [...[...specifiers.values()].map(specifier => `import type {} from '${specifier}'\n`), 'export {}\n'].join(''))
}

/**
 * Writes a tsconfig extending `tsconfig`, for tools that take a tsconfig file. Its `paths`
 * are the tsconfig's plus `paths`, less what {@link declarationPaths} drops; the aliases
 * that are not followed get an ambient `declare module` through `types`. Declarations are
 * inferred, so `isolatedDeclarations` is off. The files are listed rather than inherited,
 * less those of a playground (see {@link projectFiles}). Each project in `references` is
 * derived the same way. It is written to `file`, or by default to a content-addressed path.
 * With `vue`, single-file components are listed too. `imports` (see {@link writeDependencyImports})
 * is listed in each derived tsconfig that lists files of its own.
 */
export async function writeDerivedTsconfig(cwd: string, tsconfig: TsConfigResult, paths: Record<string, string[]>, { file, vue = false, imports }: { file?: string, vue?: boolean, imports?: string } = {}): Promise<string> {
  const { default: ts } = await import('typescript')
  const declaration = await writeDeclarationPaths(cwd, tsconfig, paths)
  const compilerOptions: Record<string, unknown> = { paths: declaration.paths, isolatedDeclarations: false }
  if (declaration.ambient) {
    compilerOptions.types = [
      ...tsconfig.config.compilerOptions?.types ?? ts.getAutomaticTypeDirectiveNames({
        configFilePath: tsconfig.path,
        typeRoots: tsconfig.config.compilerOptions?.typeRoots?.map(root => resolve(dirname(tsconfig.path), root)),
      }, ts.sys),
      declaration.ambient,
    ]
  }
  const references = await Promise.all(referencedProjects(tsconfig).map(async project => ({ path: await writeDerivedTsconfig(cwd, project, paths, { vue, imports }) })))
  const files = projectFiles(parseProject(ts, tsconfig.path, vue), cwd)
  const contents = JSON.stringify({
    extends: tsconfig.path,
    files: [...files, ...imports && files.length ? [imports] : []].map(file => relative(cacheDir(cwd), file)),
    include: [],
    compilerOptions,
    ...references.length && { references },
  })
  return file ? writeAtomic(file, contents) : writeCached(cwd, '.json', contents)
}
