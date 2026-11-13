import { resolve } from 'pathe'

import { findTsdownConfig, loadBuilderConfig } from './config-file.ts'
import type { BuilderConfig } from './config-file.ts'

export const sharedArgs = {
  // cwd falls back to rootDir's default (indirect default)
  cwd: {
    type: 'string',
    valueHint: 'directory',
    description: 'Specify the working directory, this takes precedence over ROOTDIR (default: `.`)',
    default: undefined,
  },
  rootDir: {
    type: 'positional',
    description: 'Specifies the working directory (default: `.`)',
    required: false,
    default: '.',
  },
} as const

export const resolveCwdArg = (args: { cwd?: string, rootDir?: string }): string => resolve(args.cwd || args.rootDir || '.')

/** The `builder()` options of the module's tsdown config, when it has one. */
export async function loadModuleConfig(cwd: string): Promise<BuilderConfig | undefined> {
  const file = findTsdownConfig(cwd)
  return file ? loadBuilderConfig(cwd, file) : undefined
}
