import { existsSync, promises as fsp } from 'fs'
import { pathToFileURL } from 'url'
import { resolve } from 'pathe'
import consola from 'consola'
import type { ModuleMeta, NuxtModule } from '@nuxt/schema'
import { findExports } from 'mlly'

export interface BuildModuleOptions {
  rootDir: string
  stub?: boolean
  outDir?: string
}

export async function buildModule (opts: BuildModuleOptions) {
  const { build } = await import('unbuild')

  const outDir = opts.outDir || 'dist'

  await build(opts.rootDir, false, {
    declaration: true,
    stub: opts.stub,
    outDir,
    entries: [
      'src/module',
      { input: 'src/runtime/', outDir: `${outDir}/runtime`, ext: 'mjs' }
    ],
    rollup: {
      emitCJS: false,
      cjsBridge: true
    },
    externals: [
      '@nuxt/schema',
      '@nuxt/schema-edge',
      '@nuxt/kit',
      '@nuxt/kit-edge',
      'nuxt',
      'nuxt-edge',
      'nuxt3',
      'vue'
    ],
    hooks: {
      async 'rollup:done' (ctx) {
        // Generate CommonJS stup
        await writeCJSStub(ctx.options.outDir)

        // Load module meta
        const moduleEntryPath = resolve(ctx.options.outDir, 'module.mjs')
        const moduleFn: NuxtModule<any> = await import(
          pathToFileURL(moduleEntryPath).toString()
        ).then(r => r.default || r).catch((err) => {
          consola.error(err)
          consola.error('Cannot load module. Please check dist:', moduleEntryPath)
          return null
        })
        if (!moduleFn) {
          return
        }
        const moduleMeta = await moduleFn.getMeta()

        // Enhance meta using package.json
        if (ctx.pkg) {
          if (!moduleMeta.name) {
            moduleMeta.name = ctx.pkg.name
          }
          if (!moduleMeta.version) {
            moduleMeta.version = ctx.pkg.version
          }
        }

        // Write meta
        const metaFile = resolve(ctx.options.outDir, 'module.json')
        await fsp.writeFile(metaFile, JSON.stringify(moduleMeta, null, 2), 'utf8')

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

  // Read generated module types
  const moduleTypesFile = resolve(distDir, 'module.d.ts')
  const moduleTypes = await fsp.readFile(moduleTypesFile, 'utf8').catch(() => '')
  const typeExports = findExports(moduleTypes)
  const isStub = moduleTypes.includes('export *')

  const hasModuleOptions = isStub || typeExports.find(exp => exp.names.includes('ModuleOptions'))
  const hasModuleHooks = isStub || typeExports.find(exp => exp.names.includes('ModuleHooks'))

  const schemaShims = []
  const moduleImports = []

  if (meta.configKey && hasModuleOptions) {
    moduleImports.push('ModuleOptions')
    schemaShims.push(`  interface NuxtConfig { ['${meta.configKey}']?: Partial<ModuleOptions> }`)
    schemaShims.push(`  interface NuxtOptions { ['${meta.configKey}']?: ModuleOptions }`)
  }
  if (hasModuleHooks) {
    moduleImports.push('ModuleHooks')
    schemaShims.push('  interface NuxtHooks extends ModuleHooks {}')
  }

  const dtsContents = `
import { ${moduleImports.join(', ')} } from './module'

${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}

export { default } from './module'
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
const _meta = module.exports.meta = require('./module.json')
module.exports.getMeta = () => Promise.resolve(_meta)
`
  await fsp.writeFile(cjsStubFile, cjsStub, 'utf8')
}
