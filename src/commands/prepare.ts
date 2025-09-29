import type { NuxtConfig } from '@nuxt/schema'
import { defineCommand } from 'citty'
import { resolve } from 'pathe'
import { resolveCwdArg, sharedArgs } from './_shared'

export default defineCommand({
  meta: {
    name: 'prepare',
    description: 'Prepare @nuxt/module-builder environment by writing types and stubs',
  },
  args: {
    ...sharedArgs,
  },
  async run(context) {
    const { runCommand } = await import('@nuxt/cli')

    const cwd = resolve(resolveCwdArg(context.args))

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
  },
})
