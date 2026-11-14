import { existsSync, statSync } from 'node:fs'
import { relative, resolve } from 'pathe'
import { consola } from 'consola'
import { readPackageJSON } from 'pkg-types'

import { guide } from './guide.ts'
import { publishedPackage } from './package.ts'

/**
 * Warn about `package.json` fields that point at output this builder no longer produces.
 * The paths are read as published, with `publishConfig` applied.
 */
export async function checkDeprecatedPackageFields(cwd: string, { stub = false }: { stub?: boolean } = {}): Promise<void> {
  const read = await readPackageJSON(cwd).catch(() => undefined)
  const pkg = read && publishedPackage(read)
  if (!pkg) {
    return
  }

  checkLegacyDeclarationPaths(cwd, pkg)
  checkLegacyCJSPaths(cwd, pkg)
  checkStaleTypesField(cwd, pkg)
  checkSourcePaths(cwd, pkg)
  if (!stub) {
    checkNode10DeclarationPaths(cwd, pkg)
    checkMissingPaths(cwd, pkg)
  }
}

type PackageJSON = Awaited<ReturnType<typeof readPackageJSON>>

const DECLARATION_RE = /(?:^|\/)(?:module|types)\.d\.ts$/
const CJS_MODULE_RE = /module\.cjs$/

export function checkLegacyDeclarationPaths(cwd: string, pkg: PackageJSON): boolean {
  if (!missingPaths(cwd, pkg).some(path => DECLARATION_RE.test(path))) {
    return false
  }
  consola.warn(`\`@nuxt/module-builder\` no longer generates \`.d.ts\` declarations for the module entry. Replace \`.d.ts\` with \`.d.mts\` in these \`package.json\` paths: ${list(missingPaths(cwd, pkg).filter(path => DECLARATION_RE.test(path)))}. ${guide('declaration-paths')}`)
  return true
}

export function checkLegacyCJSPaths(cwd: string, pkg: PackageJSON): boolean {
  if (!missingPaths(cwd, pkg).some(path => CJS_MODULE_RE.test(path))) {
    return false
  }
  consola.warn(`\`@nuxt/module-builder\` no longer generates \`module.cjs\`, which Nuxt 3 and later do not need. Replace it with \`./dist/module.mjs\` in \`package.json\`. ${guide('modulecjs')}`)
  return true
}

export function checkStaleTypesField(cwd: string, pkg: PackageJSON): boolean {
  if (!pkg.types || resolvesForTypeScript(cwd, pkg.types)) {
    return false
  }
  consola.warn(`\`types\` in \`package.json\` points at \`${pkg.types}\`, which the build does not produce. Set it to \`./dist/types.d.mts\`, which node10 module resolution reads, or remove it: bundler module resolution reads \`exports\` instead. ${guide('the-types-field')}`)
  return true
}

/**
 * Warn about `typesVersions` paths that TypeScript's node10 resolution cannot find because
 * they rely on probing for `.d.ts`, where the build now produces `.d.mts`.
 */
export function checkNode10DeclarationPaths(cwd: string, pkg: PackageJSON): boolean {
  const entries = typesVersionsPaths(pkg).flatMap((path) => {
    const replacement = node10Replacement(cwd, path)
    return replacement ? [`\`${path}\` (use \`${replacement}\`)`] : []
  })
  if (!entries.length) {
    return false
  }
  consola.warn(`These \`typesVersions\` paths in \`package.json\` do not resolve under TypeScript's node10 module resolution, which probes for \`.d.ts\` but not for \`.d.mts\`: ${entries.join(', ')}. Write each path with its extension. ${guide('typesversions-paths')}`)
  return true
}

/** Warn about paths in `package.json` that the build did not produce, other than those the checks above explain. */
export function checkMissingPaths(cwd: string, pkg: PackageJSON): boolean {
  const paths = [...new Set(missingPaths(cwd, pkg))]
    .filter(path => !path.includes('*') && !DECLARATION_RE.test(path) && !CJS_MODULE_RE.test(path) && path !== pkg.types && !node10Replacement(cwd, path))
  if (!paths.length) {
    return false
  }
  consola.warn(`These paths in \`package.json\` do not exist after the build, so imports that resolve to them will fail: ${list(paths)}. Add the entry that produces each one, or remove the path. ${guide('paths-the-build-does-not-produce')}`)
  return true
}

export function checkSourcePaths(cwd: string, pkg: PackageJSON): boolean {
  const src = resolve(cwd, 'src')
  const paths = referencedPaths(pkg).filter(path => !relative(src, resolve(cwd, path)).startsWith('..'))
  if (!paths.length) {
    return false
  }
  consola.warn(`These paths in \`package.json\` are published pointing at the module's sources: ${list(paths)}. Point them at the build output, or set the published paths in \`publishConfig\`. ${guide('developing-without-a-stub')}`)
  return true
}

function list(paths: string[]) {
  return [...new Set(paths)].map(path => `\`${path}\``).join(', ')
}

const TS_PROBES = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts']
const TS_MODULE_PROBES = ['.d.mts', '.d.cts', '/index.d.mts', '/index.d.cts']

function isFile(path: string) {
  return existsSync(path) && statSync(path).isFile()
}

/** Whether TypeScript's node10 resolution finds a file for `path`: as written, or with a `.ts`, `.tsx`, `.d.ts` or `/index` suffix. */
function resolvesForTypeScript(cwd: string, path: string) {
  return TS_PROBES.some(suffix => isFile(resolve(cwd, path + suffix)))
}

/** The `.d.mts` or `.d.cts` file an unresolvable `path` was meant to reach, as a `./` path. */
function node10Replacement(cwd: string, path: string) {
  if (resolvesForTypeScript(cwd, path)) {
    return
  }
  const suffix = TS_MODULE_PROBES.find(suffix => isFile(resolve(cwd, path + suffix)))
  return suffix === undefined ? undefined : `./${relative(cwd, resolve(cwd, path + suffix))}`
}

function typesVersionsPaths(pkg: PackageJSON) {
  return collectStrings(pkg.typesVersions).filter(path => !path.includes('*'))
}

function missingPaths(cwd: string, pkg: PackageJSON): string[] {
  const typesVersions = new Set(typesVersionsPaths(pkg))
  return referencedPaths(pkg).filter(path => !path.startsWith('/') && !(typesVersions.has(path) ? resolvesForTypeScript(cwd, path) : existsSync(resolve(cwd, path))))
}

function referencedPaths(pkg: PackageJSON): string[] {
  return [...[pkg.exports, pkg.typesVersions, pkg.types, pkg.main, pkg.module].flatMap(collectStrings), ...collectStrings(pkg.imports).filter(path => path.startsWith('./'))]
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStrings)
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStrings)
  }
  return []
}
