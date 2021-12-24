import { existsSync, promises as fsp } from 'fs'
import { resolve, relative } from 'pathe'
import consola from 'consola'
import type { ModuleMeta, NuxtModule } from '@nuxt/schema'

let moduleMeta: ModuleMeta,
    buildRuntimeDir: string,
    moduleDefinesHooks: boolean

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
      async 'build:prepare' (ctx) {
        buildRuntimeDir = resolve(ctx.options.rootDir, '.nuxt')

        // Load module meta
        const moduleEntryPath = resolve(ctx.options.rootDir, 'src', 'module.ts')
        const moduleFn: NuxtModule<any> = await import(moduleEntryPath).then(r => r.default || r).catch((err) => {
          consola.error(err)
          consola.error('Cannot load module. Please check dist:', moduleEntryPath)
          return null
        })
        if (!moduleFn) {
          return
        }
        moduleMeta = await moduleFn.getMeta()

        // Enhance meta using package.json
        if (ctx.pkg) {
          if (!moduleMeta.name) {
            moduleMeta.name = ctx.pkg.name
          }
          if (!moduleMeta.version) {
            moduleMeta.version = ctx.pkg.version
          }
        }

        // Write development types
        const moduleFileContent = await fsp.readFile(moduleEntryPath, 'utf-8')
        // Hacky way to check that ModuleHooks has been defined
        // @todo use regex or something at least
        moduleDefinesHooks = moduleFileContent.includes('export interface ModuleHooks')
        const relativeModulePath = relative(buildRuntimeDir, moduleEntryPath)
            // hacky
            .replace('.ts', '')
        // Generate types
        await writeTypes(buildRuntimeDir, relativeModulePath)
      },
      async "rollup:build" (ctx) {
        // Write dist types
        await writeTypes(resolve(ctx.options.rootDir, 'dist'), './module')
      },
      async 'rollup:done' (ctx) {
        // Generate CommonJS stup
        await writeCJSStub(ctx.options.outDir)

        // Write meta
        const metaFile = resolve(ctx.options.outDir, 'module.json')
        await fsp.writeFile(metaFile, JSON.stringify(moduleMeta, null, 2), 'utf8')
      }
    }
  })
}

async function writeTypes (typesDir: string, relativeModulePath: string) {
  // types dir may not exist
  if (!existsSync(typesDir)) {
    await fsp.mkdir(typesDir)
  }
  const dtsFile = resolve(typesDir, 'types.d.ts')

  const schemaShims = []
  if (moduleMeta.configKey) {
    schemaShims.push(
        `  interface NuxtConfig { ['${moduleMeta.configKey}']?: Partial<ModuleOptions> }`,
        `  interface NuxtOptions { ['${moduleMeta.configKey}']?: ModuleOptions }`
    )
  }
  if (moduleDefinesHooks) {
    schemaShims.push(
        `  interface NuxtHooks extends ModuleHooks {}`
    )
  }

  const dtsContents =
      `import type { ModuleOptions${moduleDefinesHooks ? `, ModuleHooks` : ''} } from '${relativeModulePath}'


${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
export * from '${relativeModulePath}'
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
const _meta = module.exports.meta = require('./meta.json')
module.exports.getMeta = () => Promise.resolve(_meta)
`
  await fsp.writeFile(cjsStubFile, cjsStub, 'utf8')
}
