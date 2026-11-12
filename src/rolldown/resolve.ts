import { existsSync, statSync } from 'node:fs'
import { findDynamicImports, findExports, findStaticImports, findTypeExports } from 'mlly'
import { resolve } from 'pathe'

export const SCRIPT_RE: RegExp = /\.[cm]?[jt]sx?$/
export const DECLARATION_RE: RegExp = /\.d\.[cm]?ts$/
export const RELATIVE_RE: RegExp = /^\.\.?(?:\/|$)/

const EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

/** The file an extensionless or `.js`-suffixed specifier for a TypeScript source resolves to. */
export function probe(path: string): string | undefined {
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

export interface Specifier {
  specifier: string
  /** Offset of the opening quote. */
  start: number
  /** Offset after the closing quote. */
  end: number
}

const TYPE_STAR_EXPORT_RE = /\bexport\s+type\s*\*(?:\s*as\s+[\w$]+)?\s*from\s*(['"])([^'"\n]+)\1/g

/** Every string-literal module specifier in `code`: static imports, re-exports (type-only ones included) and `import()` calls. */
export function moduleSpecifiers(code: string): Specifier[] {
  const found = new Map<number, Specifier>()
  const locate = (statement: { code: string, start: number }, specifier: string) => {
    const index = Math.max(statement.code.indexOf(`'${specifier}'`), statement.code.indexOf(`"${specifier}"`))
    if (index !== -1) {
      const start = statement.start + index
      found.set(start, { specifier, start, end: start + specifier.length + 2 })
    }
  }
  for (const statement of findStaticImports(code)) {
    locate(statement, statement.specifier)
  }
  for (const statement of [...findExports(code), ...findTypeExports(code)]) {
    if (statement.specifier) {
      locate(statement, statement.specifier)
    }
  }
  for (const match of code.matchAll(TYPE_STAR_EXPORT_RE)) {
    locate({ code: match[0], start: match.index }, match[2]!)
  }
  for (const statement of findDynamicImports(code)) {
    const literal = statement.expression.match(/^\s*(['"])([^'"]+)\1\s*$/)
    if (literal) {
      locate(statement, literal[2]!)
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start)
}

/** `code` with each specifier replaced by what `replace` returns for it, when that differs. */
export function rewriteSpecifiers(code: string, replace: (specifier: string) => string | undefined): string {
  let result = ''
  let cursor = 0
  for (const { specifier, start, end } of moduleSpecifiers(code)) {
    const replacement = replace(specifier)
    if (replacement === undefined || replacement === specifier) {
      continue
    }
    result += code.slice(cursor, start) + code[start] + replacement + code[end - 1]
    cursor = end
  }
  return result + code.slice(cursor)
}

const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\b/

/** The relative specifiers of `code` that are not `import type` or `export type` statements. */
export function valueSpecifiers(code: string): Set<string> {
  const values = new Set<string>()
  for (const statement of [...findStaticImports(code), ...findExports(code)]) {
    if (statement.specifier && RELATIVE_RE.test(statement.specifier) && !TYPE_ONLY_RE.test(statement.code)) {
      values.add(statement.specifier)
    }
  }
  for (const statement of findDynamicImports(code)) {
    const literal = statement.expression.match(/^\s*(['"])(\.\.?\/[^'"]*)\1\s*$/)
    if (literal) {
      values.add(literal[2]!)
    }
  }
  return values
}
