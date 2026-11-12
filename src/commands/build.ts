import { existsSync } from 'node:fs'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { consola } from 'consola'
import { resolve } from 'pathe'

import pkg from '../../package.json' with { type: 'json' }
import { guide } from '../build/guide.ts'
import { redirectLogsToStderr } from '../build/report.ts'
import { resolveCwdArg, sharedArgs } from './_shared.ts'
import { prepareModule } from './prepare.ts'

export const MISSING_TSDOWN_HINT: string = `\`${pkg.name}\` builds with \`tsdown\`, which is a peer dependency. Install it in your module: \`pnpm add -D tsdown@"${pkg.peerDependencies.tsdown}"\`. ${guide('install-tsdown')}`

function isMissingTsdown(error: unknown) {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
    && error.message.includes('\'tsdown\'')
}

const buildArgs = {
  outDir: {
    type: 'string',
    default: 'dist',
    description: 'Build directory',
  },
  sourcemap: {
    type: 'boolean',
    default: false,
    description: 'Generate sourcemaps',
  },
  stub: {
    type: 'boolean',
    default: false,
    description: 'Stub dist instead of actually building it for development',
  },
  json: {
    type: 'boolean',
    default: false,
    description: 'Print the build size as JSON to stdout',
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

    if (context.args.json) {
      redirectLogsToStderr()
    }

    if (context.args.stub) {
      if (context.args.json) {
        throw new Error('`--json` cannot be combined with `--stub`: a stub build has no bundle to report.')
      }
      const { stub } = await import('../build/stub.ts')
      return stub(cwd, { outDir: context.args.outDir })
    }

    if (!existsSync(resolve(cwd, '.nuxt/tsconfig.json'))) {
      consola.info(`\`.nuxt\` not found, running \`nuxt-module-build prepare\` first. Add it to the module's \`dev:prepare\` script to skip this step. ${guide('preparing-nuxt')}`)
      await prepareModule(cwd)
    }

    const { build } = await import('../build/build.ts').catch((error) => {
      if (isMissingTsdown(error)) {
        consola.error(MISSING_TSDOWN_HINT)
      }
      throw error
    })
    return build(cwd, { outDir: context.args.outDir, sourcemap: context.args.sourcemap, json: context.args.json })
  },
})

export default command
