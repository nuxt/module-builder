import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { log } from '@clack/prompts'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'pathe'

export const logger = {
  info: (message: string): void => log.info(message, { spacing: 0 }),
  warn: (message: string): void => log.warn(message, { spacing: 0, output: process.stderr }),
  error: (message: string): void => log.error(message, { spacing: 0, output: process.stderr }),
}

/** The fields of `package.json` that the builder reads. */
export interface PackageJson {
  name?: string
  version?: string
  main?: string
  module?: string
  types?: string
  typings?: string
  exports?: unknown
  imports?: unknown
  typesVersions?: unknown
  files?: string[]
  publishConfig?: Record<string, unknown>
  [key: string]: unknown
}

export const SCRIPT_RE: RegExp = /\.[cm]?[jt]sx?$/
export const TYPESCRIPT_RE: RegExp = /\.[cm]?tsx?$/
export const DECLARATION_RE: RegExp = /\.d\.[cm]?ts$/
/** Declarations of scripts and of single-file components, such as `Foo.d.vue.ts`. */
export const ANY_DECLARATION_RE: RegExp = /\.d\.(?:[^/]+\.)?[cm]?ts$/
export const RELATIVE_RE: RegExp = /^\.\.?(?:\/|$)/
export const NODE_MODULES_RE: RegExp = /[\\/]node_modules[\\/]/

const EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

/** Whether `file` is a script other than a declaration. */
export function isSourceScript(file: string): boolean {
  return SCRIPT_RE.test(file) && !DECLARATION_RE.test(file)
}

/**
 * The source file a specifier refers to: the path as written, its TypeScript counterpart for
 * a `.js`-suffixed path, the path with each source extension, then an `index` file.
 */
export function probe(path: string): string | undefined {
  if (isFile(path)) {
    return path
  }
  const source = path.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')
  if (source !== path && existsSync(source)) {
    return source
  }
  if (path.endsWith('.js') && existsSync(`${source}x`)) {
    return `${source}x`
  }
  for (const extension of EXTENSIONS) {
    if (existsSync(path + extension)) {
      return path + extension
    }
  }
  for (const extension of EXTENSIONS) {
    if (existsSync(resolve(path, `index${extension}`))) {
      return resolve(path, `index${extension}`)
    }
  }
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/** `path` resolved, with symlinks in it and its existing ancestors followed, as module ids are. */
export function realpath(path: string): string {
  const resolved = resolve(path)
  if (existsSync(resolved)) {
    return resolve(realpathSync(resolved))
  }
  const parent = dirname(resolved)
  return parent === resolved ? resolved : join(realpath(parent), basename(resolved))
}

/** Whether `path` is `dir` or inside it. */
export function isInside(dir: string, path: string): boolean {
  const subpath = relative(dir, path)
  return subpath !== '..' && !subpath.startsWith('../') && !isAbsolute(subpath)
}

/** The relative specifier from the directory of `from` to `to`. */
export function relativeSpecifier(from: string, to: string): string {
  const path = relative(dirname(from), to)
  return RELATIVE_RE.test(path) ? path : `./${path}`
}

/** The `package.json` in `dir`. */
export async function readPackageJson(dir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as PackageJson
}

/**
 * The file that `specifier` resolves to from `parent`, a file or a directory path ending in
 * `/`, with the conditions of `require`.
 */
export function resolveFrom(parent: string | URL, specifier: string): string | undefined {
  try {
    return createRequire(parent).resolve(specifier)
  }
  catch {
    return undefined
  }
}

/** The directory of an installed package, found the way Node looks up `node_modules`. */
export function findPackageDir(name: string, cwd: string): string | undefined {
  return findUp(cwd, dir => existsSync(join(dir, 'node_modules', name, 'package.json')) ? join(dir, 'node_modules', name) : undefined)
}

/** The first result of `find` for `dir` or the closest directory above it. */
export function findUp<T>(dir: string, find: (dir: string) => T | undefined): T | undefined {
  for (; ; dir = dirname(dir)) {
    const found = find(dir)
    if (found !== undefined || dirname(dir) === dir) {
      return found
    }
  }
}

/** Writes `contents` to `file` unless it already holds them, so its modification time only changes with its content. */
export async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, 'utf8').catch(() => undefined) !== contents) {
    await writeFile(file, contents, 'utf8')
  }
}

/** The value of `key` in `map`, created with `create` the first time. */
export function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  if (!map.has(key)) {
    map.set(key, create())
  }
  return map.get(key)!
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp)
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
