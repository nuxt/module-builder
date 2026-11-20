import type ts from 'typescript'

import type { Transform } from '../transpile/transpile-dir.ts'

const DIRECTIVE_RE = /@ts-(?:expect-error|ignore|nocheck|check)\b/g
const LINE_DIRECTIVE_RE = /^\/\/\/?[\t ]*@ts-(?:expect-error|ignore|nocheck|check)\b/
const BLOCK_DIRECTIVE_RE = /^[\t /*]*@ts-(?:expect-error|ignore)\b/
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

/** Whether TypeScript reads `comment` as a directive, which a block comment holds on its last line. */
function isDirective(comment: string) {
  return comment.startsWith('/*') ? BLOCK_DIRECTIVE_RE.test(comment.split(LINE_TERMINATOR_RE).at(-1)!) : LINE_DIRECTIVE_RE.test(comment)
}

/**
 * The comment that holds `offset`, or `undefined` when `offset` is not in a comment, such as in
 * a string, a template or JSX text.
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
      if (!before && node.kind < ts.SyntaxKind.FirstNode) {
        return
      }
      // Between its children, a node holds only punctuation, keywords and trivia.
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, text, undefined, before ? before.end : node.getStart(sourceFile))
      for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken && scanner.getTokenStart() <= offset; kind = scanner.scan()) {
        if ((kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) && offset < scanner.getTokenEnd()) {
          return { pos: scanner.getTokenStart(), end: scanner.getTokenEnd() }
        }
      }
      return
    }
    if (offset < containing.getStart(sourceFile)) {
      return holding(containing.pos)
    }
    node = containing
  }
}
