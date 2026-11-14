import { basename, relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'

import { guide } from './guide.ts'

const PUBLISH_CONFIG_FIELDS = ['bin', 'browser', 'exports', 'imports', 'main', 'module', 'types', 'typings', 'typesVersions'] as const

/** The fields of `package.json` whose paths are checked for pointing at the module's sources. */
const PATH_FIELDS = ['exports', 'imports', 'main', 'module', 'types', 'typings', 'typesVersions'] as const
type PathField = typeof PATH_FIELDS[number]

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

/** The paths in `pkg` that point into `src` or `.nuxt`, by field. */
export function sourcePaths(cwd: string, pkg: PackageJson): Array<{ field: PathField, path: string }> {
  const dirs = [resolve(cwd, 'src'), resolve(cwd, '.nuxt')]
  return PATH_FIELDS.flatMap(field => collectStrings(pkg[field])
    .filter(path => (field !== 'imports' || path.startsWith('./')) && dirs.some(dir => !relative(dir, resolve(cwd, path)).startsWith('..')))
    .map(path => ({ field, path })))
}

/**
 * Why packing or publishing `pkg` from the current `prepack` or `prepublishOnly` script
 * would publish paths into `src` or `.nuxt`, or `undefined` when it would not.
 */
export function sourcePathsPackError(cwd: string, pkg: PackageJson, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!PACK_EVENTS.has(env.npm_lifecycle_event ?? '')) {
    return
  }
  const paths = sourcePaths(cwd, pkg)
  const client = packingClient(env)
  const publishConfig = (pkg.publishConfig ?? {}) as Record<string, unknown>
  const published = paths.filter(({ field }) => !client?.fields.includes(field) || publishConfig[field] === undefined)
  if (!published.length) {
    const replacements = sourcePaths(cwd, Object.fromEntries(PATH_FIELDS.filter(field => client?.fields.includes(field)).map(field => [field, publishConfig[field]])))
    if (!replacements.length) {
      return
    }
    return `These fields of \`publishConfig\` point at the module's sources, so they would be published: ${list(replacements.map(({ field }) => field))} (${list(replacements.map(({ path }) => path))}). Point them at \`dist\`. ${guide('publishing-source-exports')}`
  }
  const unsupported = [...new Set(published.filter(({ field }) => !client?.fields.includes(field)).map(({ field }) => field))]
  const pathList = list(published.filter(({ field }) => !unsupported.length || unsupported.includes(field)).map(({ path }) => path))
  if (unsupported.length) {
    const name = client ? `\`${client.name}${client.version ? `@${client.version}` : ''}\`` : 'This package manager'
    const alternatives = unsupported.every(field => YARN_PUBLISH_CONFIG_FIELDS[4]!.includes(field)) ? 'pnpm or Yarn 4' : 'pnpm'
    return `${name} packs these fields of \`package.json\` as written, and they point at the module's sources: ${list(unsupported)} (${pathList}). Point them at \`dist\`, or pack and publish with ${alternatives}, which replace them with the \`dist\` paths in \`publishConfig\`. ${guide('publishing-source-exports')}`
  }
  const fields = [...new Set(published.map(({ field }) => field))]
  return `These fields of \`package.json\` point at the module's sources, and \`publishConfig\` does not replace them, so they would be published as written: ${list(fields)} (${pathList}). Set ${list(fields.map(field => `publishConfig.${field}`))} to the \`dist\` paths. ${guide('publishing-source-exports')}`
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
