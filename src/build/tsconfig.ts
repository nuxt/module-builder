import type { TsConfigResult } from 'get-tsconfig'
import { relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'

/**
 * `paths` pointing the package's own name and `exports` subpaths at its sources, so
 * self-referencing imports type-check before `dist` exists.
 */
export function selfReferencePaths(cwd: string, pkg: PackageJson, outDir: string): Record<string, string[]> {
  if (!pkg.name) {
    return {}
  }
  const paths: Record<string, string[]> = { [pkg.name]: [resolve(cwd, 'src/module')] }
  if (!pkg.exports || typeof pkg.exports !== 'object' || Array.isArray(pkg.exports)) {
    return paths
  }
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const file = exportTarget(target)
    if (!subpath.startsWith('./') || !file) {
      continue
    }
    const distPath = relative(outDir, resolve(cwd, file))
    if (!distPath.startsWith('..')) {
      paths[`${pkg.name}/${subpath.slice(2)}`] = [resolve(cwd, 'src', distPath.replace(/(?:\.d)?\.[cm]?[jt]s$/, ''))]
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

export function hasIsolatedDeclarations(tsconfig: TsConfigResult | undefined) {
  return tsconfig?.config.compilerOptions?.isolatedDeclarations === true
}
