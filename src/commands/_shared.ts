import { guide } from '../build/guide.ts'
import { realpath } from '../utils.ts'
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

export const resolveCwdArg = (args: { cwd?: string, rootDir?: string }): string => realpath(args.cwd || args.rootDir || '.')

export function assertNoStubArg(command: 'build' | 'prepare', args: Record<string, unknown>): void {
  if (args.stub) {
    throw new Error(`\`nuxt-module-build ${command} --stub\` has been removed. With pnpm or Yarn 4, point \`package.json\` at the module's sources. Otherwise, build \`dist\` with \`tsdown\` and rebuild it with \`tsdown --watch\`. ${guide('stub-builds')}`)
  }
}

/** The `builder()` options of the module's tsdown config, when it has one. */
export async function loadModuleConfig(cwd: string): Promise<BuilderConfig | undefined> {
  const file = findTsdownConfig(cwd)
  return file ? loadBuilderConfig(cwd, file) : undefined
}
