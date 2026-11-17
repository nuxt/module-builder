import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Diagnostic } from 'nostics'
import { basename, dirname, resolve } from 'pathe'

import { BUILDER_OPTIONS } from '../build/options.ts'
import type { BuilderOptions } from '../build/options.ts'
import { assertLoadableModuleCode, importModule } from '../build/loader.ts'
import { errors } from '../diagnostics.ts'

const TSDOWN_CONFIG_FILES = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map(extension => `tsdown.config.${extension}`)

/** The tsdown config file in `cwd`, if there is one. */
export function findTsdownConfig(cwd: string): string | undefined {
  const file = TSDOWN_CONFIG_FILES.find(file => existsSync(resolve(cwd, file)))
  return file && resolve(cwd, file)
}

export function missingBuilderError(file: string): Diagnostic {
  return errors.NUXT_MB_C0005({ file: basename(file), sources: [file] })
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
async function loadBuilderConfig(cwd: string, file: string): Promise<BuilderConfig> {
  if (!file.endsWith('.json')) {
    assertLoadableModuleCode(cwd, [file], [])
  }
  const exported = file.endsWith('.json')
    ? JSON.parse(await readFile(file, 'utf8')) as unknown
    : await importModule(file, { cwd }).then(module => module.default ?? module)
  const watch = {
    restart: () => Promise.reject(new Error('`watch.restart` is only available while tsdown watches the module.')),
    close: async () => {},
  }
  const resolved = typeof exported === 'function' ? await exported({ cwd, config: file }, { ci: !!process.env.CI, watch }) : await exported
  const found: BuilderConfig[] = []
  for (const config of [resolved].flat() as Array<{ plugins?: unknown, outDir?: string, cwd?: string } | undefined>) {
    for (const plugin of await flattenPlugins(config?.plugins)) {
      if (plugin && typeof plugin === 'object' && BUILDER_OPTIONS in plugin) {
        if (config?.cwd !== undefined && resolve(dirname(file), config.cwd) !== resolve(cwd)) {
          throw errors.NUXT_MB_C0007({ file: basename(file), sources: [file] })
        }
        found.push({ options: plugin[BUILDER_OPTIONS] as BuilderOptions, outDir: config?.outDir })
      }
    }
  }
  if (found.length > 1) {
    throw errors.NUXT_MB_C0006({ file: basename(file), sources: [file] })
  }
  if (!found[0]) {
    throw missingBuilderError(file)
  }
  return found[0]
}

/** The `builder()` options of the module's tsdown config, when it has one. */
export async function loadModuleConfig(cwd: string): Promise<BuilderConfig | undefined> {
  const file = findTsdownConfig(cwd)
  return file ? loadBuilderConfig(cwd, file) : undefined
}

/** Whether `plugins`, in any of the shapes a tsdown config accepts, contain `builder()`. */
export async function hasBuilder(plugins: unknown): Promise<boolean> {
  return (await flattenPlugins(plugins)).some(plugin => !!plugin && typeof plugin === 'object' && BUILDER_OPTIONS in plugin)
}

async function flattenPlugins(plugins: unknown): Promise<unknown[]> {
  const awaited = await plugins
  return Array.isArray(awaited) ? (await Promise.all(awaited.map(flattenPlugins))).flat() : [awaited]
}
