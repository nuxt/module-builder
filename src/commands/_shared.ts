import { errors } from '../diagnostics.ts'
import { realpath } from '../utils.ts'

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

export const resolveCwdArg = (args: { cwd?: string, rootDir?: string }): string => realpath(args.cwd || args.rootDir || '.')

export function assertNoStubArg(command: 'build' | 'prepare', args: Record<string, unknown>): void {
  if (args.stub) {
    throw errors.NUXT_MB_D0001({ command })
  }
}
