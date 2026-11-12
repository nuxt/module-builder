import { pathToFileURL } from 'node:url'
import { resolvePath } from 'mlly'
import type { Rolldown } from 'tsdown'

import type { ReplaceOptions } from './build-config.ts'

/**
 * rolldown's built-in replace plugin. It is loaded from the copy of rolldown that
 * tsdown runs, because built-in plugins only work with the binding that created them.
 */
export async function replacePlugin({ values, ...options }: ReplaceOptions): Promise<Rolldown.RolldownPluginOption> {
  const tsdown = await resolvePath('tsdown', { url: import.meta.url })
  const plugins = await resolvePath('rolldown/plugins', { url: tsdown })
  const { replacePlugin } = await import(pathToFileURL(plugins).href) as { replacePlugin: (values: Record<string, string>, options: Omit<ReplaceOptions, 'values'>) => Rolldown.RolldownPluginOption }
  return replacePlugin(values, options)
}
