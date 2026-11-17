import { findDynamicImports, findExports, findStaticImports, findTypeExports } from 'mlly'

import { RELATIVE_RE } from '../utils.ts'

const JSX_RE = /\.[jt]sx$/

/** The extension `file` is emitted with: `.jsx` for a JSX source when JSX is preserved, `extension` otherwise. */
export function scriptExtension(file: string, extension: string, preserveJsx: boolean): string {
  return preserveJsx && JSX_RE.test(file) ? '.jsx' : extension
}

export interface Specifier {
  specifier: string
  /** Offset of the opening quote. */
  start: number
  /** Offset after the closing quote. */
  end: number
}

const DYNAMIC_IMPORT_RE = /^\s*(?:\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/\s*)*(?:(['"])([^'"\n]+)\1|`([^`$]+)`)\s*(?:,[\s\S]*)?$/

/** The specifier of an `import()` whose first argument is a string literal. */
function dynamicImportSpecifier(expression: string) {
  const match = expression.match(DYNAMIC_IMPORT_RE)
  return match ? match[2] ?? match[3] : undefined
}

const TYPE_STAR_EXPORT_RE = /\bexport\s+type\s*\*(?:\s*as\s+[\w$]+)?\s*from\s*(['"])([^'"\n]+)\1/g

/** Every string-literal module specifier in `code`: static imports, re-exports (type-only ones included) and `import()` calls. */
export function moduleSpecifiers(code: string): Specifier[] {
  const found = new Map<number, Specifier>()
  const locate = (statement: { code: string, start: number }, specifier: string) => {
    const index = Math.max(...['\'', '"', '`'].map(quote => statement.code.indexOf(`${quote}${specifier}${quote}`)))
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
    const specifier = dynamicImportSpecifier(statement.expression)
    if (specifier) {
      locate(statement, specifier)
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
    const specifier = dynamicImportSpecifier(statement.expression)
    if (specifier && RELATIVE_RE.test(specifier)) {
      values.add(specifier)
    }
  }
  return values
}
