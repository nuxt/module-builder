import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { consola } from 'consola'

import pkg from '../../package.json' with { type: 'json' }
import { guide } from '../build/guide.ts'
import { loadModuleConfig, resolveCwdArg, sharedArgs } from './_shared.ts'

export const MISSING_TSDOWN_HINT: string = `\`${pkg.name}\` builds with \`tsdown\`, which is a peer dependency. Install it in your module: \`pnpm add -D tsdown@"${pkg.peerDependencies.tsdown}"\`. ${guide('install-tsdown')}`

function isMissingTsdown(error: unknown) {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
    && error.message.includes('\'tsdown\'')
}

const buildArgs = {
  outDir: {
    type: 'string',
    valueHint: 'directory',
    description: 'Build directory, overriding the tsdown config\'s `outDir` (default: `dist`)',
  },
  sourcemap: {
    type: 'boolean',
    description: 'Generate sourcemaps, overriding the tsdown config\'s `sourcemap`',
  },
  stub: {
    type: 'boolean',
    default: false,
    description: 'Stub dist instead of actually building it for development',
  },
} as const

const command: CommandDef<typeof sharedArgs & typeof buildArgs> = defineCommand({
  meta: {
    name: 'build',
    description: 'Build module for distribution',
  },
  args: {
    ...sharedArgs,
    ...buildArgs,
  },
  async run(context) {
    const cwd = resolveCwdArg(context.args)

    if (context.args.stub) {
      const [{ stub }, moduleConfig] = await Promise.all([import('../build/stub.ts'), loadModuleConfig(cwd)])
      return stub(cwd, {
        outDir: context.args.outDir ?? moduleConfig?.outDir ?? 'dist',
        outDirFromConfig: context.args.outDir === undefined && moduleConfig?.outDir !== undefined,
        moduleOptions: moduleConfig?.options,
      })
    }

    const { build } = await import('../tsdown/build.ts').catch((error) => {
      if (isMissingTsdown(error)) {
        consola.error(MISSING_TSDOWN_HINT)
      }
      throw error
    })
    return build(cwd, { outDir: context.args.outDir, sourcemap: context.args.sourcemap })
  },
})

export default command
