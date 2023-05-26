import { resolve } from 'pathe'

export interface PrepareModuleOptions {
  rootDir: string
}

export async function prepareModule (options: PrepareModuleOptions) {
  const { runCommand } = await import('nuxi')

  return runCommand('prepare', [options.rootDir], {
    overrides: {
      typescript: {
        builder: 'shared'
      },
      imports: {
        autoImport: false
      },
      modules: [
        resolve(options.rootDir, './src/module'),
        function (_options, nuxt) {
          nuxt.hooks.hook('app:templates', (app) => {
            for (const template of app.templates) {
              template.write = true
            }
          })
        }
      ]
    }
  })
}
