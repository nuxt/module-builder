import { createRequire } from 'node:module'
import type ts from 'typescript'

import { RELATIVE_RE } from '../utils.ts'

const JSX_RE = /\.[jt]sx$/
const DYNAMIC_IMPORT_RE = /\bimport\s*(?:\(|\/[*/])/
const VUE_SCRIPT_RE = /(<script\b[^>]*>)([\s\S]*?)<\/script\b[^>]*>/gi
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

let typescript: typeof import('typescript') | undefined

/** `code` parsed by TypeScript, as the language that the extension of `filename` implies. */
export function parseModule(code: string, filename: string): { ts: typeof import('typescript'), sourceFile: ts.SourceFile } {
  const ts = typescript ??= createRequire(import.meta.url)('typescript') as typeof import('typescript')
  const sourceFile = ts.createSourceFile(filename, code, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone })
  return { ts, sourceFile }
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
  const { ts, sourceFile } = parseModule(code, filename)
  const found: Reference[] = []
  const add = (node: ts.StringLiteralLike, typeOnly: boolean) => {
    found.push({ specifier: node.text, start: offset + node.getStart(sourceFile), end: offset + node.end, typeOnly })
  }
  const visitStatements = (statements: ts.NodeArray<ts.Statement>) => {
    for (const statement of statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        add(statement.moduleSpecifier, !!statement.importClause?.isTypeOnly)
      }
      else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        add(statement.moduleSpecifier, statement.isTypeOnly)
      }
      else if (ts.isModuleDeclaration(statement) && statement.body && ts.isModuleBlock(statement.body)) {
        visitStatements(statement.body.statements)
      }
    }
  }
  visitStatements(sourceFile.statements)
  if (DYNAMIC_IMPORT_RE.test(code)) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        add(node.arguments[0], false)
      }
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        add(node.argument.literal, true)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
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
    result += code.slice(cursor, start) + code[start] + replacement + code[end - 1]
    cursor = end
  }
  return result + code.slice(cursor)
}

/** The relative specifiers of `code` that are not `import type`, `export type` or `import()` types. */
export function valueSpecifiers(code: string, filename = 'module.ts'): Set<string> {
  return new Set(references(code, filename).filter(({ specifier, typeOnly }) => !typeOnly && RELATIVE_RE.test(specifier)).map(({ specifier }) => specifier))
}
