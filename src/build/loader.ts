import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'pathe'

import type { Transform } from '../rolldown/transpile-dir.ts'

const EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

interface Oxc {
  transform: Transform
}

let oxc: Oxc | null | undefined

/** The oxc bindings of the `rolldown` that `tsdown` depends on, or `null` when `tsdown` is not installed. */
export function loadOxc() {
  if (oxc === undefined) {
    try {
      oxc = createRequire(import.meta.resolve('tsdown'))('rolldown/utils') as Oxc
    }
    catch {
      oxc = null
    }
  }
  return oxc
}

/**
 * Find the source file a specifier refers to, trying the path as written, its
 * TypeScript counterpart, each source extension, then an `index` file.
 */
export function probe(path: string) {
  if (existsSync(path) && statSync(path).isFile()) {
    return path
  }
  const source = path.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')
  if (source !== path && existsSync(source)) {
    return source
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
