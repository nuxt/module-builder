import type { NuxtConfig } from '@nuxt/schema'
import { defineCommand } from 'citty'
import { resolve } from 'pathe'

export default defineCommand({
  meta: {
    name: 'prepare',
    description: 'Prepare @nuxt/module-builder environment by writing types and stubs'
  },
  args: {
    cwd: {
      type: 'string',
      description: 'Current working directory'
    },
    rootDir: {
      type: 'positional',
      description: 'Root directory',
      required: false
    }
  },
  async run (context) {
    const { runCommand } = await import('nuxi')

    const cwd = resolve(context.args.cwd || context.args.rootDir || '.')

    return runCommand('prepare', [cwd], {
      overrides: {
        typescript: {
          builder: 'shared'
        },
        imports: {
          autoImport: false
        },
        modules: [
          resolve(cwd, './src/module'),
          function (_options, nuxt) {
            nuxt.hooks.hook('app:templates', (app) => {
              for (const template of app.templates) {
                template.write = true
              }
            })
          }
        ]
      } satisfies NuxtConfig
    })
  }
})
