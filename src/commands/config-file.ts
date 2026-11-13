import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'pathe'

import { BUILDER_OPTIONS } from '../build/build-config.ts'
import type { BuilderOptions } from '../build/build-config.ts'
import { guide } from '../build/guide.ts'
import { assertLoadableModuleCode, importModule } from '../build/loader.ts'

const TSDOWN_CONFIG_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map(extension => `tsdown.config.${extension}`)

/** The tsdown config file in `cwd`, if there is one. */
export function findTsdownConfig(cwd: string): string | undefined {
  const file = TSDOWN_CONFIG_FILES.find(file => existsSync(resolve(cwd, file)))
  return file && resolve(cwd, file)
}

export function missingBuilderError(file: string): Error {
  return new Error([
    `\`${basename(file)}\` does not build the module with \`builder()\`. Add the plugin:`,
    '',
    `  import { builder } from '@nuxt/module-builder/tsdown'`,
    `  import { defineConfig } from 'tsdown'`,
    '',
    `  export default defineConfig({`,
    `    plugins: [builder()],`,
    `  })`,
    '',
    guide('tsdown-config'),
  ].join('\n'))
}

export interface BuilderConfig {
  options: BuilderOptions
  /** The `outDir` of the config that uses `builder()`. */
  outDir?: string
}

/**
 * Finds the options of the `builder()` plugin in a tsdown config file, which may export
 * a config, an array of configs, or a function returning either.
 */
export async function loadBuilderConfig(cwd: string, file: string): Promise<BuilderConfig> {
  if (!file.endsWith('.json')) {
    assertLoadableModuleCode(cwd, [file], [])
  }
  const exported = file.endsWith('.json')
    ? JSON.parse(await readFile(file, 'utf8')) as unknown
    : await importModule(file, { cwd }).then(module => module.default ?? module)
  const resolved = typeof exported === 'function' ? await exported({ cwd, config: file }, { ci: !!process.env.CI }) : await exported
  const found: BuilderConfig[] = []
  for (const config of [resolved].flat() as Array<{ plugins?: unknown, outDir?: string } | undefined>) {
    for (const plugin of await flattenPlugins(config?.plugins)) {
      if (plugin && typeof plugin === 'object' && BUILDER_OPTIONS in plugin) {
        found.push({ options: plugin[BUILDER_OPTIONS] as BuilderOptions, outDir: config?.outDir })
      }
    }
  }
  if (found.length > 1) {
    throw new Error(`\`${basename(file)}\` uses \`builder()\` in more than one config. Build the module with one of them. ${guide('tsdown-config')}`)
  }
  if (!found[0]) {
    throw missingBuilderError(file)
  }
  return found[0]
}

/** Whether `plugins`, in any of the shapes a tsdown config accepts, contain `builder()`. */
export async function hasBuilder(plugins: unknown): Promise<boolean> {
  return (await flattenPlugins(plugins)).some(plugin => !!plugin && typeof plugin === 'object' && BUILDER_OPTIONS in plugin)
}

async function flattenPlugins(plugins: unknown): Promise<unknown[]> {
  const awaited = await plugins
  return Array.isArray(awaited) ? (await Promise.all(awaited.map(flattenPlugins))).flat() : [awaited]
}
