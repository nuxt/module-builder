import { existsSync } from 'node:fs'
import { resolve } from 'pathe'
import { consola } from 'consola'
import { readPackageJSON } from 'pkg-types'

import { guide } from './guide.ts'

/** Warn about `package.json` fields that point at output this builder no longer produces. */
export async function checkDeprecatedPackageFields(cwd: string) {
  const pkg = await readPackageJSON(cwd).catch(() => undefined)
  if (!pkg) {
    return
  }

  checkLegacyDeclarationPaths(cwd, pkg)
  checkLegacyCJSPaths(cwd, pkg)
  checkStaleTypesField(cwd, pkg)
}

type PackageJSON = Awaited<ReturnType<typeof readPackageJSON>>

const DECLARATION_RE = /(?:^|\/)(?:module|types)\.d\.ts$/
const CJS_MODULE_RE = /module\.cjs$/

export function checkLegacyDeclarationPaths(cwd: string, pkg: PackageJSON) {
  if (!missingPaths(cwd, pkg).some(path => DECLARATION_RE.test(path))) {
    return false
  }
  consola.warn(`\`@nuxt/module-builder\` no longer generates \`.d.ts\` declarations for the module entry. Replace \`.d.ts\` with \`.d.mts\` in these \`package.json\` paths: ${list(missingPaths(cwd, pkg).filter(path => DECLARATION_RE.test(path)))}. ${guide('declaration-paths')}`)
  return true
}

export function checkLegacyCJSPaths(cwd: string, pkg: PackageJSON) {
  if (!missingPaths(cwd, pkg).some(path => CJS_MODULE_RE.test(path))) {
    return false
  }
  consola.warn(`\`@nuxt/module-builder\` no longer generates \`module.cjs\`, which Nuxt 3 and later do not need. Replace it with \`./dist/module.mjs\` in \`package.json\`. ${guide('modulecjs')}`)
  return true
}

export function checkStaleTypesField(cwd: string, pkg: PackageJSON) {
  if (!pkg.types || existsSync(resolve(cwd, pkg.types))) {
    return false
  }
  consola.warn(`Remove the \`types\` field from \`package.json\`: it points at \`${pkg.types}\`, which the build does not produce, and bundler module resolution reads \`exports\` instead. Use \`typesVersions\` for subpath export types under Node10 resolution, if required. ${guide('the-types-field')}`)
  return true
}

function list(paths: string[]) {
  return [...new Set(paths)].map(path => `\`${path}\``).join(', ')
}

function missingPaths(cwd: string, pkg: PackageJSON): string[] {
  return referencedPaths(pkg).filter(path => path.startsWith('.') && !existsSync(resolve(cwd, path)))
}

function referencedPaths(pkg: PackageJSON): string[] {
  const paths: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      paths.push(value)
    }
    else if (Array.isArray(value)) {
      value.forEach(visit)
    }
    else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit)
    }
  }
  visit(pkg.exports)
  visit(pkg.typesVersions)
  visit(pkg.types)
  visit(pkg.main)
  visit(pkg.module)
  return paths
}
