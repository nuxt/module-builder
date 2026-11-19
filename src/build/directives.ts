import type ts from 'typescript'

import type { Transform } from '../transpile/transpile-dir.ts'

const DIRECTIVE_RE = /@ts-(?:expect-error|ignore|nocheck|check)\b/g
const FIRST_LINE_DIRECTIVE_RE = /^\/(?:\/\/?|\*+)[\t ]*@ts-(?:expect-error|ignore|nocheck|check)\b/
const LAST_LINE_DIRECTIVE_RE = /^[\t *]*@ts-(?:expect-error|ignore)\b/
const LINE_TERMINATOR_RE = /\r\n?|[\n\u2028\u2029]/
const NOT_LINE_TERMINATOR_RE = /[^\n\r\u2028\u2029]/g

const SCRIPT_KINDS: Record<string, keyof typeof ts.ScriptKind> = { js: 'JS', jsx: 'JSX', ts: 'TS', tsx: 'TSX' }

/**
 * `transform` with the TypeScript directive comments of the source, such as `// @ts-ignore`
 * and `// @ts-expect-error`, replaced by spaces, so that the output leaves them out and its
 * source map still matches the source. Other comments are kept.
 */
export function withoutDirectiveComments(transform: Transform): Transform {
  return async (filename, source, options) => transform(filename, source.search(DIRECTIVE_RE) === -1 ? source : await blankDirectiveComments(source, options?.lang ?? 'ts'), options)
}

async function blankDirectiveComments(source: string, lang: string) {
  const { default: ts } = await import('typescript')
  const sourceFile = ts.createSourceFile(`source.${lang}`, source, ts.ScriptTarget.Latest, false, ts.ScriptKind[SCRIPT_KINDS[lang] ?? 'TS'])
  const comments = new Map<number, number>()
  for (const { index } of source.matchAll(DIRECTIVE_RE)) {
    const comment = commentAt(ts, sourceFile, index)
    if (comment && isDirective(source.slice(comment.pos, comment.end))) {
      comments.set(comment.pos, comment.end)
    }
  }
  let result = source
  for (const [pos, end] of comments) {
    result = result.slice(0, pos) + source.slice(pos, end).replace(NOT_LINE_TERMINATOR_RE, ' ') + result.slice(end)
  }
  return result
}

/** Whether TypeScript reads `comment` as a directive: on its first line, or on the last line of a block comment. */
function isDirective(comment: string) {
  return FIRST_LINE_DIRECTIVE_RE.test(comment) || (comment.startsWith('/*') && LAST_LINE_DIRECTIVE_RE.test(comment.split(LINE_TERMINATOR_RE).at(-1)!))
}

/**
 * The comment that holds `offset`, or `undefined` when `offset` is not in a comment, such as in
 * a string, a template or JSX text. Of the comments between two tokens of one node, only those
 * after its last child or its first token are found.
 */
function commentAt(ts: typeof import('typescript'), sourceFile: ts.SourceFile, offset: number) {
  const text = sourceFile.text
  const holding = (pos: number) => [...ts.getTrailingCommentRanges(text, pos) ?? [], ...ts.getLeadingCommentRanges(text, pos) ?? []].find(range => range.pos <= offset && offset < range.end)
  let node: ts.Node = sourceFile
  for (;;) {
    let containing: ts.Node | undefined
    let before: ts.Node | undefined
    ts.forEachChild(node, (child) => {
      if (child.end <= offset) {
        before = child
        return
      }
      if (child.pos <= offset) {
        containing = child
      }
      return true
    })
    if (!containing) {
      if (before) {
        return holding(before.end)
      }
      if (node.kind < ts.SyntaxKind.FirstNode) {
        return
      }
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sourceFile.languageVariant, text, undefined, node.getStart(sourceFile))
      scanner.scan()
      return holding(scanner.getTokenEnd())
    }
    if (offset < containing.getStart(sourceFile)) {
      return holding(containing.pos)
    }
    node = containing
  }
}
