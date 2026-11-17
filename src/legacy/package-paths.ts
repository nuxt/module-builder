/**
 * Advice for `package.json` paths to the `.d.ts` declarations and `module.cjs` that v1
 * of `@nuxt/module-builder` generated for the module entry.
 */

import { guide } from '../build/guide.ts'
import { list, missingPaths, warnWhen } from '../build/package.ts'
import type { PackageJson } from '../utils.ts'

const DECLARATION_RE = /(?:^|\/)(?:module|types)\.d\.ts$/
const CJS_MODULE_RE = /(?:^|\/)module\.cjs$/

/** Whether `path` is one that v1 generated and the build no longer does, which the checks below explain. */
export function isLegacyPath(path: string): boolean {
  return DECLARATION_RE.test(path) || CJS_MODULE_RE.test(path)
}

export function checkLegacyDeclarationPaths(cwd: string, pkg: PackageJson): boolean {
  const paths = missingPaths(cwd, pkg).filter(path => DECLARATION_RE.test(path))
  return warnWhen(paths.length > 0, `\`@nuxt/module-builder\` no longer generates \`.d.ts\` declarations for the module entry. Replace \`.d.ts\` with \`.d.mts\` in these \`package.json\` paths: ${list(paths)}. ${guide('declaration-paths')}`)
}

export function checkLegacyCJSPaths(cwd: string, pkg: PackageJson): boolean {
  return warnWhen(missingPaths(cwd, pkg).some(path => CJS_MODULE_RE.test(path)), `\`@nuxt/module-builder\` no longer generates \`module.cjs\`, which Nuxt 3 and later do not need. Replace it with \`./dist/module.mjs\` in \`package.json\`. ${guide('modulecjs')}`)
}
