import { existsSync, realpathSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'

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

/** `path` resolved, with symlinks followed when it exists, as module ids are. */
export function realpath(path: string): string {
  const resolved = resolve(path)
  return existsSync(resolved) ? resolve(realpathSync(resolved)) : resolved
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
