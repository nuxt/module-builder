import { build as tsdownBuild } from 'tsdown'
import type { TsdownPlugin } from 'tsdown'

import { findTsdownConfig, hasBuilder, missingBuilderError } from '../commands/config-file.ts'
import { createBuilder } from './plugin.ts'

export interface BuildOptions {
  outDir?: string
  sourcemap?: boolean
}

/**
 * Builds the module in `cwd` with its tsdown config, or without one from `build.config.*`
 * and `package.json`.
 */
export async function build(cwd: string, options: BuildOptions): Promise<void> {
  const file = findTsdownConfig(cwd)
  await tsdownBuild({
    cwd,
    config: file ?? false,
    ...options.outDir !== undefined && { outDir: options.outDir },
    ...options.sourcemap !== undefined && { sourcemap: options.sourcemap },
    plugins: file ? [requireBuilder(file)] : [createBuilder({}, { legacy: true })],
  })
}

/**
 * Fails the build unless the tsdown config uses `builder()`. Configs without it build
 * other entries alongside the module, so one without an `entry` of its own fails straight away.
 */
function requireBuilder(file: string): TsdownPlugin {
  let found = false
  return {
    name: 'nuxt-module-builder:require-builder',
    async tsdownConfig(config) {
      if (await hasBuilder(config.plugins)) {
        found = true
      }
      else if (config.entry === undefined) {
        throw missingBuilderError(file)
      }
      const hooks = config.hooks
      config.hooks = async (hookable) => {
        hookable.hook('build:prepare', () => {
          if (!found) {
            throw missingBuilderError(file)
          }
        })
        if (typeof hooks === 'function') {
          await hooks(hookable)
        }
        else if (hooks) {
          hookable.addHooks(hooks)
        }
      }
    },
  }
}
