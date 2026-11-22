import type { Expression, Statement } from '@oxc-project/types'

import { RELATIVE_RE } from '../utils.ts'
import { literalText, parseModule, walk } from './oxc.ts'

const JSX_RE = /\.[jt]sx$/
const DYNAMIC_IMPORT_RE = /\bimport\s*(?:\(|\/[*/])/
const VUE_SCRIPT_RE = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script\b[^>]*>/gi
const VUE_LANG_RE = /\blang\s*=\s*["']?(\w+)/

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

interface Reference extends Specifier {
  /** Whether the reference is `import type`, `export type` or an `import()` type. */
  typeOnly: boolean
}

function references(code: string, filename: string): Reference[] {
  if (!filename.endsWith('.vue')) {
    return scriptReferences(code, filename, 0)
  }
  return [...code.matchAll(VUE_SCRIPT_RE)].flatMap(({ 1: tag, 2: content, index }) => {
    const lang = tag!.match(VUE_LANG_RE)?.[1] ?? 'js'
    return scriptReferences(content!, `${filename}.${lang}`, index + tag!.length)
  })
}

function scriptReferences(code: string, filename: string, offset: number): Reference[] {
  const { program } = parseModule(code, filename)
  const found: Reference[] = []
  const add = (node: Expression, typeOnly: boolean) => {
    const specifier = literalText(node)
    if (specifier !== undefined) {
      found.push({ specifier, start: offset + node.start, end: offset + node.end, typeOnly })
    }
  }
  const visitStatements = (statements: Statement[]) => {
    for (const node of statements) {
      const statement = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node
      if (statement.type === 'ImportDeclaration') {
        add(statement.source, statement.importKind === 'type')
      }
      else if ((statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration') && statement.source) {
        add(statement.source, statement.exportKind === 'type')
      }
      else if (statement.type === 'TSImportEqualsDeclaration' && statement.moduleReference.type === 'TSExternalModuleReference') {
        add(statement.moduleReference.expression, statement.importKind === 'type')
      }
      else if (statement.type === 'TSModuleDeclaration' && statement.id.type !== 'TSQualifiedName' && statement.body) {
        visitStatements(statement.body.body)
      }
    }
  }
  visitStatements(program.body)
  if (DYNAMIC_IMPORT_RE.test(code)) {
    walk(program, (node) => {
      if (node.type === 'ImportExpression') {
        add(node.source, false)
      }
      else if (node.type === 'TSImportType') {
        add(node.source, true)
      }
    })
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * Every string-literal module specifier in `code`, a script or a single-file component named
 * `filename`: static imports, re-exports (type-only ones included), `import()` calls and types.
 */
export function moduleSpecifiers(code: string, filename = 'module.ts'): Specifier[] {
  return references(code, filename).map(({ specifier, start, end }) => ({ specifier, start, end }))
}

/** `code` with each specifier replaced by what `replace` returns for it, when that differs. */
export function rewriteSpecifiers(code: string, replace: (specifier: string) => string | undefined, filename?: string): string {
  let result = ''
  let cursor = 0
  for (const { specifier, start, end } of moduleSpecifiers(code, filename)) {
    const replacement = replace(specifier)
    if (replacement === undefined || replacement === specifier) {
      continue
    }
    result += code.slice(cursor, start) + code[start] + replacement.replace(/[\\'"`]|\$\{/g, match => `\\${match}`) + code[end - 1]
    cursor = end
  }
  return result + code.slice(cursor)
}

/** The relative specifiers of `code` that are not `import type`, `export type` or `import()` types. */
export function valueSpecifiers(code: string, filename = 'module.ts'): Set<string> {
  return new Set(references(code, filename).filter(({ specifier, typeOnly }) => !typeOnly && RELATIVE_RE.test(specifier)).map(({ specifier }) => specifier))
}
