import { resolve } from 'pathe'

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
