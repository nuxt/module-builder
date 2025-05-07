import type { NuxtConfig } from '@nuxt/schema'
import { defineCommand } from 'citty'
import { resolve } from 'pathe'

export default defineCommand({
  meta: {
    name: 'prepare',
    description: 'Prepare @nuxt/module-builder environment by writing types and stubs',
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Current working directory',
    },
    rootDir: {
      type: 'positional',
      description: 'Root directory',
      required: false,
    },
    autoImport: {
      type: 'boolean',
      description: 'Enable auto import',
      default: false,
    },
  },
  async run(context) {
    const { runCommand } = await import('@nuxt/cli')

    const cwd = resolve(context.args.cwd || context.args.rootDir || '.')

    return runCommand('prepare', [cwd], {
      overrides: {
        compatibilityDate: '2024-04-03',
        typescript: {
          builder: 'shared',
        },
        imports: {
          autoImport: context.args.autoImport,
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
