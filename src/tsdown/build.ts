import { build as tsdownBuild } from 'tsdown'

import { createBuilder } from './plugin.ts'

export interface BuildOptions {
  outDir?: string
  sourcemap?: boolean
}

/** Builds the module in `cwd` from `build.config.*` and `package.json`, without a tsdown config. */
export async function build(cwd: string, options: BuildOptions): Promise<void> {
  await tsdownBuild({
    cwd,
    config: false,
    ...options.outDir !== undefined && { outDir: options.outDir },
    ...options.sourcemap !== undefined && { sourcemap: options.sourcemap },
    plugins: [createBuilder({}, { legacy: true })],
  })
}
