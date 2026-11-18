import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'

import { errors } from '../diagnostics.ts'
import { assertNoStubArg, resolveCwdArg, sharedArgs } from './_shared.ts'

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
    assertNoStubArg('build', context.args)
    const cwd = resolveCwdArg(context.args)
    const { build } = await import('../tsdown/build.ts').catch((error: unknown) => {
      throw isMissingTsdown(error) ? errors.NUXT_MB_B0003({ cause: error }) : error
    })
    return build(cwd, { outDir: context.args.outDir, sourcemap: context.args.sourcemap })
  },
})

export default command
