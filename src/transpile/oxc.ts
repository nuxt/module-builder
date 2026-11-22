import { createRequire } from 'node:module'
import type { Expression, Node, Program } from '@oxc-project/types'

import type { Transform } from './transpile-dir.ts'

export type { Node, Program } from '@oxc-project/types'

type Lang = 'js' | 'jsx' | 'ts' | 'tsx' | 'dts'

interface Comment {
  type: 'Line' | 'Block'
  value: string
  start: number
  end: number
}

interface ParseResult {
  program: Program
  comments: Comment[]
  errors: Array<{ message: string }>
}

interface Oxc {
  transform: Transform
  transformSync: (...args: Parameters<Transform>) => Awaited<ReturnType<Transform>>
  parseSync: (filename: string, code: string, options?: { lang?: Lang, sourceType?: 'module' }) => ParseResult
}

let oxc: Oxc | null | undefined

/** The oxc bindings of the `rolldown` that `tsdown` depends on, or `null` when `tsdown` is not installed. */
export function loadOxc(): Oxc | null {
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

const DECLARATION_RE = /\.d\.(?:[^/]+\.)?[cm]?ts$/
const LANGS: Record<string, Lang> = { ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', jsx: 'jsx', js: 'jsx', mjs: 'jsx', cjs: 'jsx' }

/**
 * `code` parsed by oxc as the language that the extension of `filename` implies, as TypeScript
 * parses it: JSX is allowed in JavaScript, and any other extension is TypeScript.
 */
export function parseModule(code: string, filename: string): ParseResult {
  const lang = DECLARATION_RE.test(filename) ? 'dts' : LANGS[filename.slice(filename.lastIndexOf('.') + 1)] ?? 'ts'
  return loadOxc()!.parseSync(filename, code, { lang, sourceType: 'module' })
}

/** The text of a string literal, or of a template literal without substitutions. */
export function literalText(node: Expression | null | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) {
    return node.quasis[0]!.value.cooked ?? undefined
  }
}

/**
 * Calls `visit` on `node` and then on each node below it, depth first, with its parent.
 * Returning `false` skips the nodes below.
 */
export function walk(node: Node, visit: (node: Node, parent: Node | undefined) => boolean | undefined, parent?: Node): void {
  if (visit(node, parent) === false) {
    return
  }
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string') {
        walk(child as Node, visit, node)
      }
    }
  }
}
