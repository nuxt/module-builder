import type ts from 'typescript'

import type { Transform } from '../transpile/transpile-dir.ts'

const DIRECTIVE_RE = /\/[/*]\**\s*@ts-(?:expect-error|ignore|nocheck|check)\b/g

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
  let result = source
  for (const { index } of source.matchAll(DIRECTIVE_RE)) {
    const end = commentEnd(ts, sourceFile, index)
    if (end !== undefined) {
      result = result.slice(0, index) + result.slice(index, end).replace(/[^\r\n]/g, ' ') + result.slice(end)
    }
  }
  return result
}

/**
 * The end of the comment that starts at `offset`, or `undefined` when `offset` is not the start
 * of a comment, such as inside a string, a template or JSX text. Of the comments between two
 * tokens of one node, only those after its last child or its first token are found.
 */
function commentEnd(ts: typeof import('typescript'), sourceFile: ts.SourceFile, offset: number) {
  const text = sourceFile.text
  const startingAt = (pos: number) => [...ts.getTrailingCommentRanges(text, pos) ?? [], ...ts.getLeadingCommentRanges(text, pos) ?? []].find(range => range.pos === offset)?.end
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
        return startingAt(before.end)
      }
      if (node.kind < ts.SyntaxKind.FirstNode) {
        return
      }
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sourceFile.languageVariant, text, undefined, node.getStart(sourceFile))
      scanner.scan()
      return startingAt(scanner.getTokenEnd())
    }
    if (offset < containing.getStart(sourceFile)) {
      return startingAt(containing.pos)
    }
    node = containing
  }
}
