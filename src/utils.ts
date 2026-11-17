import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'pathe'

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

export const RELATIVE_RE: RegExp = /^\.\.?(?:\/|$)/

/** The relative specifier from the directory of `from` to `to`. */
export function relativeSpecifier(from: string, to: string): string {
  const path = relative(dirname(from), to)
  return RELATIVE_RE.test(path) ? path : `./${path}`
}
