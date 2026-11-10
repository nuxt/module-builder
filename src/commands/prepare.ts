import type { NuxtConfig } from '@nuxt/schema'
import { defineCommand } from 'citty'
import { resolve } from 'pathe'
import { resolveCwdArg, sharedArgs } from './_shared.ts'

export async function prepareModule(cwd: string) {
  const { runCommand } = await import('@nuxt/cli')

  return runCommand('prepare', [cwd], {
    overrides: {
      compatibilityDate: '2024-04-03',
      typescript: {
        builder: 'shared',
      },
      imports: {
        autoImport: false,
      },
      modules: [
        resolve(cwd, './src/module'),
        function (_options, nuxt) {
          nuxt.hooks.hook('app:templates', (app) => {
            for (const template of app.templates) {
              template.write = true
            }
          })
        },
      ],
    } satisfies NuxtConfig,
  })
}

export default defineCommand({
  meta: {
    name: 'prepare',
    description: 'Prepare @nuxt/module-builder environment by writing types and stubs',
  },
  args: {
    ...sharedArgs,
  },
  async run(context) {
    return prepareModule(resolveCwdArg(context.args))
  },
})
