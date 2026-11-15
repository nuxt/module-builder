import { basename, relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'

import { guide } from './guide.ts'

const PUBLISH_CONFIG_FIELDS = ['bin', 'browser', 'exports', 'imports', 'main', 'module', 'types', 'typings', 'typesVersions'] as const

/** The fields of `package.json` whose paths are checked for whether they can be published. */
const PATH_FIELDS = ['exports', 'imports', 'main', 'module', 'types', 'typings', 'typesVersions'] as const
type PathField = typeof PATH_FIELDS[number]

/** The path fields that each major version of Yarn replaces from `publishConfig` when it packs. */
const YARN_PUBLISH_CONFIG_FIELDS: Record<number, readonly PathField[]> = {
  2: ['main', 'module'],
  3: ['exports', 'imports', 'main', 'module'],
  4: ['exports', 'imports', 'main', 'module', 'types', 'typings'],
}

const PACK_EVENTS = new Set(['prepack', 'prepublishOnly'])

const TS_SOURCE_RE = /\.[cm]?tsx?$/
const UNPUBLISHABLE = 'TypeScript sources or paths that `files` leaves out'
const DECLARATION_RE = /\.d\.[cm]?ts$/

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
export function unpublishablePaths(cwd: string, pkg: PackageJson, files: string[] | undefined = pkg.files): UnpublishablePath[] {
  const alwaysPacked = new Set(['package.json', ...typeof pkg.main === 'string' ? [relative(cwd, resolve(cwd, pkg.main))] : []])
  const targets = (field: PathField): Array<{ path: string, key?: string }> => field === 'imports'
    ? Object.entries((pkg.imports ?? {}) as Record<string, unknown>).flatMap(([key, value]) => collectStrings(value).filter(path => path.startsWith('./')).map(path => ({ path, key })))
    : collectStrings(pkg[field]).map(path => ({ path }))
  return PATH_FIELDS.flatMap(field => targets(field).flatMap(({ path, key }): UnpublishablePath[] => {
    if (TS_SOURCE_RE.test(path) && !DECLARATION_RE.test(path)) {
      return [{ field, path, reason: 'source', key }]
    }
    return !packed(cwd, path, files, alwaysPacked) ? [{ field, path, reason: 'files', key }] : []
  }))
}

function packed(cwd: string, path: string, files: string[] | undefined, alwaysPacked: Set<string>): boolean {
  const file = relative(cwd, resolve(cwd, path.split('*')[0]!))
  if (!file || file.startsWith('..')) {
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
export function unpublishablePathsError(cwd: string, pkg: PackageJson): string | undefined {
  const paths = unpublishablePaths(cwd, publishedPackage(pkg)).filter(({ field }) => field !== 'imports')
  return paths.length ? `These published fields of \`package.json\` would not work once installed. ${describeUnpublishable(paths, ({ field }) => field)} ${PUBLISH_FIX}` : undefined
}

/**
 * Why the `imports` entries that `pkg` publishes, with `publishConfig` applied, would not work
 * once the package is installed, or `undefined` when they would. Only entries whose key
 * `isImported` reports as imported from the build output are checked.
 */
export function unpublishableImportsError(cwd: string, pkg: PackageJson, isImported: (key: string) => boolean): string | undefined {
  const paths = unpublishablePaths(cwd, publishedPackage(pkg)).filter(({ field, key }) => field === 'imports' && isImported(key!))
  return paths.length ? `The build output imports these \`imports\` of \`package.json\`, which would not work once installed. ${describeUnpublishable(paths, ({ key }) => key!)} ${PUBLISH_FIX}` : undefined
}

const PUBLISH_FIX = `Point them at the build output, in \`publishConfig\` when \`package.json\` points at the sources. To publish a file other than a TypeScript source as it is, add it to \`files\`. ${guide('publishing-source-exports')}`

function describeUnpublishable(paths: UnpublishablePath[], name: (path: UnpublishablePath) => string) {
  return ([['source', 'TypeScript sources, which Node does not load from `node_modules`'], ['files', 'paths that the pack leaves out']] as const).flatMap(([reason, what]) => {
    const matching = paths.filter(path => path.reason === reason)
    return matching.length ? [`Pointing at ${what}: ${list(matching.map(name))} (${list(matching.map(({ path }) => path))}).`] : []
  }).join(' ')
}

/**
 * Why packing or publishing `pkg` from the current `prepack` or `prepublishOnly` script
 * would publish paths that do not work once installed (see `unpublishablePaths`), or `undefined`
 * when it would not.
 */
export function sourcePathsPackError(cwd: string, pkg: PackageJson, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!PACK_EVENTS.has(env.npm_lifecycle_event ?? '')) {
    return
  }
  const paths = unpublishablePaths(cwd, pkg)
  const client = packingClient(env)
  const publishConfig = (pkg.publishConfig ?? {}) as Record<string, unknown>
  const published = paths.filter(({ field }) => !client?.fields.includes(field) || publishConfig[field] === undefined)
  if (!published.length) {
    const replaced = PATH_FIELDS.filter(field => client?.fields.includes(field) && publishConfig[field] !== undefined)
    const replacements = unpublishablePaths(cwd, { ...pkg, ...Object.fromEntries(replaced.map(field => [field, publishConfig[field]])) }).filter(({ field }) => replaced.includes(field))
    if (!replacements.length) {
      return
    }
    return `These fields of \`publishConfig\` point at ${UNPUBLISHABLE}, so they would be published that way: ${list(replacements.map(({ field }) => field))} (${list(replacements.map(({ path }) => path))}). Point them at \`dist\`. ${guide('publishing-source-exports')}`
  }
  const unsupported = [...new Set(published.filter(({ field }) => !client?.fields.includes(field)).map(({ field }) => field))]
  const pathList = list(published.filter(({ field }) => !unsupported.length || unsupported.includes(field)).map(({ path }) => path))
  if (unsupported.length) {
    const name = client ? `\`${client.name}${client.version ? `@${client.version}` : ''}\`` : 'This package manager'
    const alternatives = unsupported.every(field => YARN_PUBLISH_CONFIG_FIELDS[4]!.includes(field)) ? 'pnpm or Yarn 4' : 'pnpm'
    return `${name} packs these fields of \`package.json\` as written, and they point at ${UNPUBLISHABLE}: ${list(unsupported)} (${pathList}). Point them at \`dist\`, or pack and publish with ${alternatives}, which replace them with the \`dist\` paths in \`publishConfig\`. ${guide('publishing-source-exports')}`
  }
  const fields = [...new Set(published.map(({ field }) => field))]
  return `These fields of \`package.json\` point at ${UNPUBLISHABLE}, and \`publishConfig\` does not replace them, so they would be published as written: ${list(fields)} (${pathList}). Set ${list(fields.map(field => `publishConfig.${field}`))} to the \`dist\` paths. ${guide('publishing-source-exports')}`
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

function list(values: string[]) {
  return [...new Set(values)].map(value => `\`${value}\``).join(', ')
}

export function collectStrings(value: unknown): string[] {
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
