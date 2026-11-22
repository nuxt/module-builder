import { parseModule } from '../transpile/oxc.ts'
import type { Transform } from '../transpile/transpile-dir.ts'

const DIRECTIVE_RE = /@ts-(?:expect-error|ignore|nocheck|check)\b/
const LINE_DIRECTIVE_RE = /^\/\/\/?[\t ]*@ts-(?:expect-error|ignore|nocheck|check)\b/
const BLOCK_DIRECTIVE_RE = /^[\t /*]*@ts-(?:expect-error|ignore)\b/
const LINE_TERMINATOR_RE = /\r\n?|[\n\u2028\u2029]/
const NOT_LINE_TERMINATOR_RE = /[^\n\r\u2028\u2029]/g

/**
 * `transform` with the TypeScript directive comments of the source, such as `// @ts-ignore`
 * and `// @ts-expect-error`, replaced by spaces, so that the output leaves them out and its
 * source map still matches the source. Other comments are kept.
 */
export function withoutDirectiveComments(transform: Transform): Transform {
  return async (filename, source, options) => transform(filename, source.search(DIRECTIVE_RE) === -1 ? source : blankDirectiveComments(source, options?.lang ?? 'ts'), options)
}

function blankDirectiveComments(source: string, lang: string) {
  let result = source
  for (const { start, end } of parseModule(source, `source.${lang}`).comments) {
    const comment = source.slice(start, end)
    if (isDirective(comment)) {
      result = result.slice(0, start) + comment.replace(NOT_LINE_TERMINATOR_RE, ' ') + result.slice(end)
    }
  }
  return result
}

/** Whether TypeScript reads `comment` as a directive, which a block comment holds on its last line. */
function isDirective(comment: string) {
  return comment.startsWith('/*') ? BLOCK_DIRECTIVE_RE.test(comment.split(LINE_TERMINATOR_RE).at(-1)!) : LINE_DIRECTIVE_RE.test(comment)
}
