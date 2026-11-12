import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { createFilesMatcher, createPathsMatcher, getTsconfig, parseTsconfig } from 'get-tsconfig'
import type { TsConfigResult } from 'get-tsconfig'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'
import type ts from 'typescript'

export interface TsconfigResolver {
  /** The nearest tsconfig, which may delegate files to `references`. */
  root: TsConfigResult | undefined
  /** The tsconfig a source file is compiled with. */
  resolve: (file: string) => TsConfigResult | undefined
  /** The tsconfig found above `dir` when it took its generated types from another app's `.nuxt`, which `.nuxt/tsconfig.json` replaces in `root`. */
  replaced?: string
}

/**
 * Finds the nearest tsconfig above `dir`, or reads `file`. When it has `references`, each
 * source file is compiled with the referenced project that includes it, falling back to
 * the tsconfig itself. A tsconfig whose generated types come from a `.nuxt` other than
 * `dir`'s own (a playground's, typically) is rebuilt on `dir/.nuxt/tsconfig.json`, see
 * {@link rebaseOnOwnBuildDir}.
 */
export async function createTsconfigResolver(dir: string, file?: string): Promise<TsconfigResolver> {
  const path = file && resolve(dir, file)
  let root = path ? { path, config: parseTsconfig(path) } : getTsconfig(dir) ?? undefined
  let replaced: string | undefined
  const own = join(dir, '.nuxt/tsconfig.json')
  if (root && !path && usesForeignBuildDir(root, dir) && existsSync(own)) {
    replaced = root.path
    root = await rebaseOnOwnBuildDir(root.path, own, dir)
  }
  const projects = referencedProjects(root).map(project => ({ project, matches: createFilesMatcher(project) }))

  const scriptPath = (file: string) => file.endsWith('.vue') ? `${file}.ts` : file

  return {
    root,
    resolve: file => projects.find(({ matches }) => matches(scriptPath(file)))?.project ?? root,
    ...replaced && { replaced },
  }
}

function usesForeignBuildDir(tsconfig: TsConfigResult, dir: string) {
  const targets = Object.values(tsconfigPaths(tsconfig)).flat()
  const projects = referencedProjects(tsconfig).map(project => project.path)
  return [...targets, ...projects].some(file => NUXT_BUILD_DIR_RE.test(file) && !isOwnBuildFile(file, dir))
}

function isOwnBuildFile(file: string, dir: string) {
  return !relative(join(dir, '.nuxt'), file).startsWith('..')
}

function isForeignBuildFile(file: string, dir: string) {
  return NUXT_BUILD_DIR_RE.test(file) && !isOwnBuildFile(file, dir)
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
  const read = (file: string) => ts.readConfigFile(file, ts.sys.readFile).config as RawTsconfig | undefined
  const layerOptions = (file: string): Record<string, unknown> => {
    const raw = read(file)
    const base = (Array.isArray(raw?.extends) ? raw.extends : raw?.extends ? [raw.extends] : [])
      .map(target => resolveExtends(target, dirname(file)))
      .filter(target => target !== undefined && !isForeignBuildFile(target, dir))
      .map(target => layerOptions(target!))
    return Object.assign({}, ...base, absoluteOptions(raw?.compilerOptions ?? {}, dirname(file), dirname(tsconfig)))
  }
  const ownConfig = parseTsconfig(own)
  const ownPaths = tsconfigPaths({ path: own, config: ownConfig })
  const { paths, types, ...options } = layerOptions(tsconfig)
  const ownTypes = ownConfig.compilerOptions?.types
  const config = {
    extends: own,
    compilerOptions: {
      ...options,
      paths: { ...Object.fromEntries(Object.entries((paths ?? {}) as Record<string, string[]>).filter(([, targets]) => !targets.some(target => isForeignBuildFile(target, dir)))), ...ownPaths },
      ...(ownTypes || types) ? { types: [...new Set([...ownTypes ?? [], ...(types ?? []) as string[]])] } : {},
    },
  }
  const references = (read(tsconfig)?.references ?? [])
    .map(reference => ({ path: resolve(dirname(tsconfig), reference.path) }))
    .filter(reference => !isForeignBuildFile(reference.path, dir))
  const file = await writeCached(dir, '.json', JSON.stringify({ ...config, ...references.length && { references } }))
  return { path: file, config: parseTsconfig(file) }
}

interface RawTsconfig {
  extends?: string | string[]
  compilerOptions?: Record<string, unknown>
  references?: { path: string }[]
}

function resolveExtends(target: string, from: string) {
  if (target.startsWith('.') || isAbsolute(target)) {
    const path = resolve(from, target)
    return [path, `${path}.json`, join(path, 'tsconfig.json')].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
  }
  const require = createRequire(join(from, 'tsconfig.json'))
  for (const candidate of [target, `${target}.json`, `${target}/tsconfig.json`]) {
    try {
      return require.resolve(candidate)
    }
    catch {
      continue
    }
  }
}

/** Path options resolved against `from`, the layer's directory; `${configDir}` is the leaf tsconfig's. */
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
  if (result.paths && typeof result.paths === 'object') {
    const base = typeof options.baseUrl === 'string' ? dir(options.baseUrl) : from
    result.paths = Object.fromEntries(Object.entries(result.paths as Record<string, string[]>).map(([alias, targets]) => [alias, targets.map(target => resolve(base, target.replace('${configDir}', configDir)))]))
  }
  return result
}

const FOREIGN_DIR_RE = /^(?:playgrounds?(?:-.*)?|docs|tests?|fixtures|examples?|node_modules)$/

/**
 * The files of a parsed tsconfig that belong to the module in `dir`: inside `dir`, outside
 * its playground, docs, test, fixture and example directories, and not generated for
 * another app.
 */
export function projectFiles(parsed: ts.ParsedCommandLine | undefined, dir: string): string[] {
  return (parsed?.fileNames ?? []).filter((file) => {
    const path = relative(dir, file)
    if (path.startsWith('..') || isAbsolute(path) || FOREIGN_DIR_RE.test(path.split('/')[0]!) || NODE_MODULES_RE.test(file)) {
      return false
    }
    return !NUXT_BUILD_DIR_RE.test(file) || isOwnBuildFile(file, dir)
  })
}

function referencedProjects(tsconfig: TsConfigResult | undefined): TsConfigResult[] {
  return (tsconfig?.config.references ?? []).flatMap((reference) => {
    const path = resolve(dirname(tsconfig!.path), reference.path)
    const config = path.endsWith('.json') ? path : join(path, 'tsconfig.json')
    return existsSync(config) ? [{ path: config, config: parseTsconfig(config) }] : []
  })
}

/** The tsconfig's `paths` made absolute. */
export function tsconfigPaths(tsconfig: TsConfigResult | undefined): Record<string, string[]> {
  const paths = tsconfig?.config.compilerOptions?.paths
  const matchPath = tsconfig && createPathsMatcher(tsconfig)
  if (!paths || !matchPath) {
    return {}
  }
  return Object.fromEntries(Object.keys(paths).map(alias => [alias, matchPath(alias)]))
}

const BUILD_ALIAS_RE = /^#(?:build|internal)(?:\/|$)/
const SERVER_ROUTES_ALIAS = '#build/server-routes'
const NUXT_BUILD_DIR_RE = /[\\/]\.nuxt(?:[\\/]|$)/
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/
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
    const name = /^[#~@]\//.test(alias) || alias.startsWith('#') ? undefined : alias.match(PACKAGE_NAME_RE)?.[0]
    if (name && targets.every(target => NODE_MODULES_RE.test(target)) && findPackageDir(name, cwd)) {
      continue
    }
    result.paths[alias] = targets
  }
  return result
}

function serverRoutesTable(paths: Record<string, string[]>, cwd: string) {
  const targets = [...paths[SERVER_ROUTES_ALIAS] ?? [], ...(paths['#build/*'] ?? []).map(target => target.replaceAll('*', 'server-routes'))]
  for (const target of targets) {
    const file = target.endsWith('.d.ts') ? target : `${target}.d.ts`
    if (isOwnBuildFile(file, cwd) && existsSync(file)) {
      return file
    }
  }
}

/** The directory of an installed package, found the way Node looks up `node_modules`. */
export function findPackageDir(name: string, cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const packageDir = join(dir, 'node_modules', name)
    if (existsSync(join(packageDir, 'package.json'))) {
      return packageDir
    }
    if (dirname(dir) === dir) {
      return
    }
  }
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
  if (existsSync(file)) {
    return file
  }
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

/** An ambient declaration file declaring each alias as a module. */
export function writeAmbientModules(cwd: string, ambient: string[]): Promise<string> {
  return writeCached(cwd, '.d.ts', ambient.map(alias => `declare module '${alias}'\n`).join(''))
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
 * Writes a tsconfig extending `tsconfig`, for tools that take a tsconfig file. Its `paths`
 * are the tsconfig's plus `paths`, less what {@link declarationPaths} drops; the aliases
 * that are not followed get an ambient `declare module` through `types`. Declarations are
 * inferred, so `isolatedDeclarations` is off. The files are listed rather than inherited,
 * less those of a playground (see {@link projectFiles}). Each project in `references` is
 * derived the same way.
 */
export async function writeDerivedTsconfig(cwd: string, tsconfig: TsConfigResult | undefined, paths: Record<string, string[]>): Promise<string> {
  const declaration = declarationPaths({ ...tsconfigPaths(tsconfig), ...paths }, cwd)
  await writeServerRoutesStub(cwd)
  const compilerOptions: Record<string, unknown> = { paths: declaration.paths, isolatedDeclarations: false }
  if (declaration.ambient.length) {
    compilerOptions.types = [
      ...tsconfig?.config.compilerOptions?.types ?? await automaticTypes(tsconfig, cwd),
      await writeAmbientModules(cwd, declaration.ambient),
    ]
  }
  const references = await Promise.all(referencedProjects(tsconfig).map(async project => ({ path: await writeDerivedTsconfig(cwd, project, paths) })))
  const { default: ts } = await import('typescript')
  const parsed = tsconfig && ts.getParsedCommandLineOfConfigFile(tsconfig.path, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
  return writeCached(cwd, '.json', JSON.stringify({
    ...tsconfig && { extends: tsconfig.path },
    ...tsconfig && { files: projectFiles(parsed, cwd).map(file => relative(cacheDir(cwd), file)), include: [] },
    compilerOptions,
    ...references.length && { references },
  }))
}

async function automaticTypes(tsconfig: TsConfigResult | undefined, cwd: string) {
  const { default: ts } = await import('typescript')
  const base = tsconfig ? dirname(tsconfig.path) : cwd
  return ts.getAutomaticTypeDirectiveNames({
    configFilePath: tsconfig?.path ?? join(cwd, 'tsconfig.json'),
    typeRoots: tsconfig?.config.compilerOptions?.typeRoots?.map(root => resolve(base, root)),
  }, ts.sys)
}
