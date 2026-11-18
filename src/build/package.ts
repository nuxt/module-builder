import { existsSync } from 'node:fs'
import { basename, join, relative, resolve } from 'pathe'
import { checkLegacyCJSPaths, checkLegacyDeclarationPaths, isLegacyPath } from '../legacy/package-paths.ts'
import type { Diagnostic } from 'nostics'
import { errors, warnings } from '../diagnostics.ts'
import { DECLARATION_RE, isFile, isInside, readPackageJson, TYPESCRIPT_RE } from '../utils.ts'
import type { PackageJson } from '../utils.ts'

/** The fields of `package.json` whose paths are checked for whether they can be published. */
const PATH_FIELDS = ['exports', 'imports', 'main', 'module', 'types', 'typings', 'typesVersions'] as const
type PathField = typeof PATH_FIELDS[number]

const PUBLISH_CONFIG_FIELDS: readonly string[] = ['bin', 'browser', ...PATH_FIELDS]

/** The path fields that each major version of Yarn replaces from `publishConfig` when it packs. */
const YARN_PUBLISH_CONFIG_FIELDS: Record<number, readonly PathField[]> = {
  2: ['main', 'module'],
  3: ['exports', 'imports', 'main', 'module'],
  4: ['exports', 'imports', 'main', 'module', 'types', 'typings'],
}

const PACK_EVENTS = new Set(['prepack', 'prepublishOnly'])

/** `pkg` as pnpm publishes it, with the paths in `publishConfig` replacing their top-level fields. */
export function publishedPackage(pkg: PackageJson): PackageJson {
  const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined
  if (!publishConfig) {
    return pkg
  }
  const overrides = Object.fromEntries(PUBLISH_CONFIG_FIELDS.filter(field => publishConfig[field] !== undefined).map(field => [field, publishConfig[field]]))
  return { ...pkg, ...overrides }
}

export interface UnpublishablePath {
  field: PathField
  path: string
  /** `source` for a TypeScript source other than a declaration, `files` for a path that `files` leaves out. */
  reason: 'source' | 'files'
  /** The key of an `imports` entry, such as `#internal/*`. */
  key?: string
}

/**
 * The paths in `pkg` that do not work once the package is installed: TypeScript sources other
 * than declarations, which Node does not load from `node_modules`, and paths that the pack leaves
 * out because `files` does not list them. Without `files`, paths into `.nuxt` count as left out.
 * Every pack includes `package.json` and the file that `main` points at.
 */
export function unpublishablePaths(cwd: string, pkg: PackageJson): UnpublishablePath[] {
  const alwaysPacked = new Set(['package.json', ...typeof pkg.main === 'string' ? [relative(cwd, resolve(cwd, pkg.main))] : []])
  const targets = (field: PathField): Array<{ path: string, key?: string }> => field === 'imports'
    ? Object.entries((pkg.imports ?? {}) as Record<string, unknown>).flatMap(([key, value]) => collectStrings(value).filter(path => path.startsWith('./')).map(path => ({ path, key })))
    : collectStrings(pkg[field]).map(path => ({ path }))
  return PATH_FIELDS.flatMap(field => targets(field).flatMap(({ path, key }): UnpublishablePath[] => {
    if (TYPESCRIPT_RE.test(path) && !DECLARATION_RE.test(path)) {
      return [{ field, path, reason: 'source', key }]
    }
    return !packed(cwd, path, pkg.files, alwaysPacked) ? [{ field, path, reason: 'files', key }] : []
  }))
}

function packed(cwd: string, path: string, files: string[] | undefined, alwaysPacked: Set<string>): boolean {
  const target = resolve(cwd, path.split('*')[0]!)
  const file = relative(cwd, target)
  if (!file || !isInside(cwd, target)) {
    return !file
  }
  if (!path.includes('*') && alwaysPacked.has(file)) {
    return true
  }
  const ancestors = file.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'))
  if (!files) {
    return ancestors[0] !== '.nuxt'
  }
  const patterns = files.map(pattern => pattern.replace(/^(!?)\.?\/+/, '$1').replace(/\/+$/, ''))
  const matches = (pattern: string) => ancestors.some(ancestor => globToRegExp(pattern).test(ancestor))
  if (patterns.some(pattern => pattern.startsWith('!') && matches(pattern.slice(1)))) {
    return false
  }
  const suffix = path.slice(path.lastIndexOf('*') + 1)
  if (path.includes('*') && suffix) {
    const prefix = relative(cwd, resolve(cwd, path.slice(0, path.indexOf('*')) + 'x')).slice(0, -1)
    return [`${prefix}x${suffix}`, `${prefix}x/x${suffix}`].some(sample => packed(cwd, `./${sample}`, files, alwaysPacked))
  }
  if (path.includes('*')) {
    return patterns.some((pattern) => {
      const base = pattern.split(/[*?{[]/)[0]!.replace(/\/$/, '')
      return !pattern.startsWith('!') && (!base || `${file}/`.startsWith(`${base}/`) || base.startsWith(`${file}/`))
    })
  }
  return patterns.some(pattern => !pattern.startsWith('!') && matches(pattern))
}

function globToRegExp(pattern: string) {
  const source = pattern.replace(/\*\*\/|\*\*|\{([^}]*)\}|\[(!?)([^\]!][^\]]*)\]|[*?.+^$()|[\]\\]/g, (match, alternatives: string | undefined, negated: string | undefined, characters: string | undefined) => {
    if (characters !== undefined) {
      return `[${negated ? '^' : ''}${characters.replace(/[\\^]/g, '\\$&')}]`
    }
    if (alternatives !== undefined) {
      return `(?:${alternatives.split(',').map(alternative => alternative.replace(/[.+^$()|[\]\\*?]/g, '\\$&')).join('|')})`
    }
    return ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' } as Record<string, string>)[match] ?? `\\${match}`
  })
  return new RegExp(`^${source}$`)
}

/**
 * Why the paths that `pkg` publishes, with `publishConfig` applied, would not work once the
 * package is installed, or `undefined` when they would.
 */
export function unpublishablePathsError(cwd: string, pkg: PackageJson): Diagnostic | undefined {
  const paths = unpublishablePaths(cwd, publishedPackage(pkg)).filter(({ field }) => field !== 'imports')
  return paths.length ? errors.NUXT_MB_C0101({ items: paths.map(({ field, path, reason }) => ({ name: field, path, reason })), sources: packageSources(cwd, paths.map(({ path }) => path)) }) : undefined
}

/**
 * Why the `imports` entries that `pkg` publishes, with `publishConfig` applied, would not work
 * once the package is installed, or `undefined` when they would. Only entries whose key
 * `isImported` reports as imported from the build output are checked.
 */
export function unpublishableImportsError(cwd: string, pkg: PackageJson, isImported: (key: string) => boolean): Diagnostic | undefined {
  const paths = unpublishablePaths(cwd, publishedPackage(pkg)).filter(({ field, key }) => field === 'imports' && isImported(key!))
  return paths.length ? errors.NUXT_MB_C0102({ items: paths.map(({ key, path, reason }) => ({ name: key!, path, reason })), sources: packageSources(cwd, paths.map(({ path }) => path)) }) : undefined
}

/** The key of `imports` that Node resolves `specifier` with: the same key, or else the matching wildcard key with the longest prefix. */
export function importsKeyFor(keys: string[], specifier: string): string | undefined {
  if (keys.includes(specifier)) {
    return specifier
  }
  return keys
    .filter((key) => {
      const [prefix, suffix, ...rest] = key.split('*')
      return suffix !== undefined && !rest.length && specifier.length >= prefix!.length + suffix.length && specifier.startsWith(prefix!) && specifier.endsWith(suffix)
    })
    .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)[0]
}

/**
 * Why packing or publishing `pkg` from the current `prepack` or `prepublishOnly` script
 * would publish paths that do not work once installed (see `unpublishablePaths`), or `undefined`
 * when it would not.
 */
export function sourcePathsPackError(cwd: string, pkg: PackageJson, env: Record<string, string | undefined> = process.env): Diagnostic | undefined {
  if (!PACK_EVENTS.has(env.npm_lifecycle_event ?? '')) {
    return
  }
  const client = packingClient(env)
  const applied = client?.fields ?? []
  const publishConfig = (pkg.publishConfig ?? {}) as Record<string, unknown>
  const replaced = PATH_FIELDS.filter(field => applied.includes(field) && publishConfig[field] !== undefined)
  const published = unpublishablePaths(cwd, pkg).filter(({ field }) => !replaced.includes(field))
  if (!published.length) {
    const replacements = unpublishablePaths(cwd, { ...pkg, ...Object.fromEntries(replaced.map(field => [field, publishConfig[field]])) }).filter(({ field }) => replaced.includes(field))
    return replacements.length
      ? errors.NUXT_MB_C0103({ fields: replacements.map(({ field }) => field), paths: replacements.map(({ path }) => path), sources: packageSources(cwd, replacements.map(({ path }) => path)) })
      : undefined
  }
  const unsupported = [...new Set(published.filter(({ field }) => !applied.includes(field)).map(({ field }) => field))]
  const paths = published.filter(({ field }) => !unsupported.length || unsupported.includes(field)).map(({ path }) => path)
  if (unsupported.length) {
    const name = client ? `\`${client.name}${client.version ? `@${client.version}` : ''}\`` : 'This package manager'
    const alternatives = unsupported.every(field => YARN_PUBLISH_CONFIG_FIELDS[4]!.includes(field)) ? 'pnpm or Yarn 4' : 'pnpm'
    return errors.NUXT_MB_C0104({ client: name, fields: unsupported, paths, alternatives, sources: packageSources(cwd, paths) })
  }
  return errors.NUXT_MB_C0105({ fields: published.map(({ field }) => field), paths, sources: packageSources(cwd, paths) })
}

/** The `package.json` in `cwd` and `paths` in it, as the `sources` of a diagnostic about them. */
export function packageSources(cwd: string, paths: string[] = []): string[] {
  return [resolve(cwd, 'package.json'), ...paths.filter(path => !path.includes('*')).map(path => resolve(cwd, path))]
}

/**
 * The package manager running the current script, as far as `npm_config_user_agent` and
 * `npm_execpath` tell. Each is inherited from a parent script unless the package manager
 * sets it, so of the two, the one that applies fewer `publishConfig` fields is taken.
 */
function packingClient(env: Record<string, string | undefined>) {
  const [, agent, version] = env.npm_config_user_agent?.match(/^([^/\s]+)\/(\S+)/) ?? []
  const execName = env.npm_execpath ? basename(env.npm_execpath).match(/^[a-z]+/i)?.[0]?.toLowerCase() : undefined
  const candidates = [
    ...agent ? [{ name: agent, version }] : [],
    ...execName ? [{ name: execName, version: execName === agent ? version : undefined }] : [],
  ]
  return candidates
    .map(candidate => ({ ...candidate, fields: publishConfigFields(candidate.name, candidate.version) }))
    .sort((a, b) => a.fields.length - b.fields.length)[0]
}

function publishConfigFields(name: string, version: string | undefined): readonly PathField[] {
  if (name === 'pnpm') {
    return PATH_FIELDS
  }
  if (name === 'yarn') {
    return YARN_PUBLISH_CONFIG_FIELDS[Number(version?.split('.')[0])] ?? []
  }
  return []
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
    if (isInside(outDir, resolve(cwd, file))) {
      const name = relative(outDir, resolve(cwd, file)).replace(/(?:\.d)?\.[cm]?[jt]s$/, '')
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

/**
 * Warn about `package.json` fields that point at output this builder no longer produces.
 * The paths are read as published, with `publishConfig` applied.
 */
export async function checkPublishedPaths(cwd: string): Promise<void> {
  const read = await readPackageJson(cwd).catch(() => undefined)
  if (!read) {
    return
  }
  const pkg = publishedPackage(read)
  checkLegacyDeclarationPaths(cwd, pkg)
  checkLegacyCJSPaths(cwd, pkg)
  checkStaleTypesField(cwd, pkg)
  checkNode10DeclarationPaths(cwd, pkg)
  checkMissingPaths(cwd, pkg)
}

export function checkStaleTypesField(cwd: string, pkg: PackageJson): boolean {
  const stale = !!pkg.types && !resolvesForTypeScript(cwd, pkg.types)
  if (stale) {
    warnings.NUXT_MB_C0201({ path: pkg.types!, sources: packageSources(cwd, [pkg.types!]) })
  }
  return stale
}

/**
 * Warn about `typesVersions` paths that TypeScript's node10 resolution cannot find because
 * they rely on probing for `.d.ts`, where the build now produces `.d.mts`.
 */
export function checkNode10DeclarationPaths(cwd: string, pkg: PackageJson): boolean {
  const paths = typesVersionsPaths(pkg).flatMap((path) => {
    const replacement = node10Replacement(cwd, path)
    return replacement ? [{ path, replacement }] : []
  })
  if (paths.length) {
    warnings.NUXT_MB_C0202({ paths, sources: packageSources(cwd, paths.flatMap(({ path, replacement }) => [path, replacement])) })
  }
  return paths.length > 0
}

/** Warn about paths in `package.json` that the build did not produce, other than those the checks above explain. */
export function checkMissingPaths(cwd: string, pkg: PackageJson): boolean {
  const paths = [...new Set(missingPaths(cwd, pkg))]
    .filter(path => !path.includes('*') && !isLegacyPath(path) && path !== pkg.types && !node10Replacement(cwd, path))
  if (paths.length) {
    warnings.NUXT_MB_C0203({ paths, sources: packageSources(cwd, paths) })
  }
  return paths.length > 0
}

const TS_PROBES = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '/index.d.ts']
const TS_MODULE_PROBES = ['.d.mts', '.d.cts', '/index.d.mts', '/index.d.cts']

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

function typesVersionsPaths(pkg: PackageJson) {
  return collectStrings(pkg.typesVersions).filter(path => !path.includes('*'))
}

export function missingPaths(cwd: string, pkg: PackageJson): string[] {
  const typesVersions = new Set(typesVersionsPaths(pkg))
  const paths = [...[pkg.exports, pkg.typesVersions, pkg.types, pkg.main, pkg.module].flatMap(collectStrings), ...collectStrings(pkg.imports).filter(path => path.startsWith('./'))]
  return paths.filter(path => !path.startsWith('/') && !(typesVersions.has(path) ? resolvesForTypeScript(cwd, path) : existsSync(resolve(cwd, path))))
}
