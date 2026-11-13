import type { TsdownPlugin } from 'tsdown'

import { BUILDER_OPTIONS } from '../build/build-config.ts'
import type { BuilderOptions } from '../build/build-config.ts'
import type { BuilderSession, SetupOptions } from './setup.ts'

export interface BuilderPlugin extends TsdownPlugin {
  [BUILDER_OPTIONS]: BuilderOptions
}

/**
 * A tsdown plugin that builds a Nuxt module: `src/module` and `entries` are bundled,
 * `src/runtime` and directory entries are transpiled file by file, and declarations,
 * `module.json` and `types.d.mts` are generated.
 *
 * ```ts
 * // tsdown.config.ts
 * import { builder } from '@nuxt/module-builder/tsdown'
 * import { defineConfig } from 'tsdown'
 *
 * export default defineConfig({
 *   plugins: [builder()],
 * })
 * ```
 *
 * It sets `entry`, `format`, `dts`, `clean` and `deps.neverBundle`, so the config leaves
 * them out apart from additional `deps.neverBundle` entries.
 */
export function builder(options: BuilderOptions = {}): BuilderPlugin {
  return createBuilder(options, { legacy: false })
}

export function createBuilder(options: BuilderOptions, setupOptions: SetupOptions): BuilderPlugin {
  let session: BuilderSession | undefined
  let claimed = false
  return {
    name: 'nuxt-module-builder',
    [BUILDER_OPTIONS]: options,
    async tsdownConfig(config, inline) {
      // A watcher that restarts resolves the config again once the first build has started.
      if (claimed && !session?.started) {
        throw new Error('The same `builder()` plugin is used in more than one tsdown config. Call `builder()` in each config that builds the module.')
      }
      claimed = true
      const { setupBuilder } = await import('./setup.ts')
      session = await setupBuilder(config, inline, options, setupOptions)
    },
    buildStart() {
      session?.onBuildStart()
      for (const dir of session?.watchDirs ?? []) {
        this.addWatchFile(dir)
      }
    },
    tsdownConfigResolved(resolved) {
      session?.checkResolved(resolved)
    },
    async buildEnd(error) {
      await session?.onBuildEnd(error)
    },
    writeBundle: {
      order: 'post',
      async handler(_options, bundle) {
        await session?.onWriteBundle(bundle)
      },
    },
  }
}
