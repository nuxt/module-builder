/**
 * Advice for `package.json` paths to the `.d.ts` declarations and `module.cjs` that v1
 * of `@nuxt/module-builder` generated for the module entry.
 */
import { consola } from 'consola'
import type { PackageJson } from 'pkg-types'

import { guide } from '../build/guide.ts'
import { list, missingPaths } from '../build/package.ts'

const DECLARATION_RE = /(?:^|\/)(?:module|types)\.d\.ts$/
const CJS_MODULE_RE = /(?:^|\/)module\.cjs$/

/** Whether `path` is one that v1 generated and the build no longer does, which the checks below explain. */
export function isLegacyPath(path: string): boolean {
  return DECLARATION_RE.test(path) || CJS_MODULE_RE.test(path)
}

export function checkLegacyDeclarationPaths(cwd: string, pkg: PackageJson): boolean {
  const paths = missingPaths(cwd, pkg).filter(path => DECLARATION_RE.test(path))
  if (!paths.length) {
    return false
  }
  consola.warn(`\`@nuxt/module-builder\` no longer generates \`.d.ts\` declarations for the module entry. Replace \`.d.ts\` with \`.d.mts\` in these \`package.json\` paths: ${list(paths)}. ${guide('declaration-paths')}`)
  return true
}

export function checkLegacyCJSPaths(cwd: string, pkg: PackageJson): boolean {
  if (!missingPaths(cwd, pkg).some(path => CJS_MODULE_RE.test(path))) {
    return false
  }
  consola.warn(`\`@nuxt/module-builder\` no longer generates \`module.cjs\`, which Nuxt 3 and later do not need. Replace it with \`./dist/module.mjs\` in \`package.json\`. ${guide('modulecjs')}`)
  return true
}
