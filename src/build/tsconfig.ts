import type { TsConfigResult } from 'get-tsconfig'
import { join, relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'

import { publishedPackage } from './package.ts'

/**
 * `paths` pointing the package's own name and `exports` subpaths at its sources, so
 * self-referencing imports type-check before `dist` exists. A subpath that points at a
 * bundled entry of `entries`, keyed by output name, maps to that entry's input.
 */
export function selfReferencePaths(cwd: string, pkg: PackageJson, outDir: string, entries: Record<string, string> = {}): Record<string, string[]> {
  if (!pkg.name) {
    return {}
  }
  const paths: Record<string, string[]> = { [pkg.name]: [resolve(cwd, 'src/module')] }
  const { exports } = publishedPackage(pkg)
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) {
    return paths
  }
  for (const [subpath, target] of Object.entries(exports)) {
    const file = exportTarget(target)
    if (!subpath.startsWith('./') || !file) {
      continue
    }
    const distPath = relative(outDir, resolve(cwd, file))
    if (!distPath.startsWith('..')) {
      const name = distPath.replace(/(?:\.d)?\.[cm]?[jt]s$/, '')
      const input = Object.hasOwn(entries, name) ? entries[name]!.replace(/\.[cm]?[jt]sx?$/, '') : join('src', name)
      paths[`${pkg.name}/${subpath.slice(2)}`] = [resolve(cwd, input)]
    }
  }
  return paths
}

function exportTarget(target: unknown): string | undefined {
  if (typeof target === 'string') {
    return target
  }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const conditions = target as Record<string, unknown>
    return exportTarget(conditions.import ?? conditions.default ?? conditions.types)
  }
}

export function hasIsolatedDeclarations(tsconfig: TsConfigResult | undefined): boolean {
  return tsconfig?.config.compilerOptions?.isolatedDeclarations === true
}
