import type { PackageJson } from 'pkg-types'

const PUBLISH_CONFIG_FIELDS = ['bin', 'browser', 'exports', 'imports', 'main', 'module', 'types', 'typings', 'typesVersions'] as const

/** `pkg` as pnpm publishes it, with the paths in `publishConfig` replacing their top-level fields. */
export function publishedPackage(pkg: PackageJson): PackageJson {
  const publishConfig = pkg.publishConfig as Record<string, unknown> | undefined
  if (!publishConfig) {
    return pkg
  }
  const overrides = Object.fromEntries(PUBLISH_CONFIG_FIELDS.filter(field => publishConfig[field] !== undefined).map(field => [field, publishConfig[field]]))
  return { ...pkg, ...overrides }
}
