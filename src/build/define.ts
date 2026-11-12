import type { PackageJson } from 'pkg-types'

export interface BuildEntry {
  input: string
  name?: string
  builder?: 'rollup' | 'mkdist'
  outDir?: string
  [option: string]: unknown
}

/** The context passed to `build:before`, `rollup:done` and `build:done` hooks. */
export interface BuildContext {
  options: {
    name: string
    /** Absolute path of the module root. */
    rootDir: string
    /** Absolute path of the output directory. */
    outDir: string
    /** Every entry built, with absolute `input` and `outDir`, including `src/module` and `src/runtime/`. */
    entries: Array<BuildEntry & { name: string, builder: 'rollup' | 'mkdist', outDir: string }>
    declaration?: unknown
    stub: boolean
    sourcemap: boolean
  }
  pkg: PackageJson
}

export type BuildHook = (ctx: BuildContext) => void | Promise<void>

export interface BuildConfig {
  entries?: Array<string | BuildEntry>
  externals?: Array<string | RegExp>
  replace?: Record<string, string>
  rollup?: Record<string, unknown>
  hooks?: {
    'build:before'?: BuildHook
    'rollup:done'?: BuildHook
    'build:done'?: BuildHook
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } & Record<string, (...args: any[]) => unknown>
  [option: string]: unknown
}

/**
 * Type helper for a legacy `build.config.ts`, which `nuxt-module-build` still reads.
 * Supported options are `entries`, `externals`, `replace`, `rollup.replace` and the
 * `build:before`, `rollup:done` and `build:done` hooks.
 *
 * @deprecated `build.config.ts` will stop being read in a future major.
 */
export function defineBuildConfig<T extends BuildConfig | BuildConfig[]>(config: T): T {
  return config
}
