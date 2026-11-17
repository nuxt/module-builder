/**
 * Advice for `package.json` paths to the `.d.ts` declarations and `module.cjs` that v1
 * of `@nuxt/module-builder` generated for the module entry.
 */

import { missingPaths, packageSources } from '../build/package.ts'
import { warnings } from '../diagnostics.ts'
import type { PackageJson } from '../utils.ts'

const DECLARATION_RE = /(?:^|\/)(?:module|types)\.d\.ts$/
const CJS_MODULE_RE = /(?:^|\/)module\.cjs$/

/** Whether `path` is one that v1 generated and the build no longer does, which the checks below explain. */
export function isLegacyPath(path: string): boolean {
  return DECLARATION_RE.test(path) || CJS_MODULE_RE.test(path)
}

export function checkLegacyDeclarationPaths(cwd: string, pkg: PackageJson): boolean {
  const paths = missingPaths(cwd, pkg).filter(path => DECLARATION_RE.test(path))
  if (paths.length) {
    warnings.NUXT_MB_D0104({ paths, sources: packageSources(cwd, paths) })
  }
  return paths.length > 0
}

export function checkLegacyCJSPaths(cwd: string, pkg: PackageJson): boolean {
  const found = missingPaths(cwd, pkg).some(path => CJS_MODULE_RE.test(path))
  if (found) {
    warnings.NUXT_MB_D0105({ sources: packageSources(cwd) })
  }
  return found
}
