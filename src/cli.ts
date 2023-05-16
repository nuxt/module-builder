#!/usr/bin/env node

/* eslint-disable no-console */
import mri from 'mri'
import { resolve } from 'pathe'
import { buildModule } from './build'

// TODO: use citty
async function main () {
  const args = mri(process.argv.slice(2))
  if ('prepare' in args) {
    return prepare()
  }
  return build()
}

async function build () {
  const args = mri(process.argv.slice(2))
  const rootDir = resolve(args._[0] || '.')
  await buildModule({
    rootDir,
    outDir: args.outDir,
    stub: args.stub
  })
}

async function prepare () {
  const { runCommand } = await import('nuxi')
  const args = mri(process.argv.slice(2))
  const rootDir = resolve(args._[0] || '.')

  return runCommand('prepare', [rootDir], {
    overrides: {
      typescript: {
        builder: 'shared'
      },
      imports: {
        autoImport: false
      },
      modules: [
        resolve(rootDir, './src/module'),
        function (options, nuxt) {
          nuxt.hooks.hook('app:templates', app => {
            for (const template of app.templates) {
              template.write = true
            }
          })
        }
      ]
    }
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
