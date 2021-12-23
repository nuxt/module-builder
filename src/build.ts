import { existsSync, promises as fsp } from 'fs'
import { resolve } from 'pathe'
import consola from 'consola'
import type { ModuleMeta } from '@nuxt/schema'

export async function buildModule (rootDir: string) {
  const { build } = await import('unbuild')

  await build(rootDir, false, {
    declaration: true,
    entries: [
      'src/module',
      { input: 'src/runtime/', outDir: 'dist/runtime', ext: 'mjs' }
    ],
    rollup: {
      emitCJS: false,
      cjsBridge: true
    },
    externals: [
      '@nuxt/schema',
      '@nuxt/schema-edge',
      '@nuxt/kit',
      '@nuxt/kit-edge'
    ],
    hooks: {
      async 'rollup:done' (ctx) {
        // Generate CommonJS stup
        await writeCJSStub(ctx.options.outDir)

        // Load module meta
        const moduleEntryPath = resolve(ctx.options.outDir, 'module.mjs')
        const moduleFn = await import(moduleEntryPath).then(r => r.default || r).catch((err) => {
          consola.error(err)
          console.error('Cannot load module. Please check dist:', moduleEntryPath)
          return null
        })
        if (!moduleFn) {
          return
        }
        const moduleMeta = await moduleFn.getMeta()

        // Generate types
        await writeTypes(ctx.options.outDir, moduleMeta)
      }
    }
  })
}

async function writeTypes (distDir: string, meta: ModuleMeta) {
  const dtsFile = resolve(distDir, 'types.d.ts')
  if (existsSync(dtsFile)) {
    return
  }

  const schemaShims = []
  if (meta.configKey) {
    schemaShims.push(
      `  interface NuxtConfig { ['${meta.configKey}']?: Partial<ModuleOptions> }`,
      `  interface NuxtOptions { ['${meta.configKey}']?: ModuleOptions }`
    )
  }

  const dtsContents = `
import type { ModuleOptions } from './module'

${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
export * from './module'
`

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
}

async function writeCJSStub (distDir: string) {
  const cjsStubFile = resolve(distDir, 'module.cjs')
  if (existsSync(cjsStubFile)) {
    return
  }
  const cjsStub = `module.exports = function(...args) {
  return import('./module.mjs').then(m => m.default.call(this, ...args))
}
module.exports.meta = require('../package.json')
`
  await fsp.writeFile(cjsStubFile, cjsStub, 'utf8')
}
