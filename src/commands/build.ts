import { existsSync, promises as fsp } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'pathe'
import { consola } from 'consola'
import type { ModuleMeta, NuxtModule } from '@nuxt/schema'
import { findExports } from 'mlly'
import { defineCommand } from 'citty'

export default defineCommand({
  meta: {
    name: 'build',
    description: 'Build module for distribution',
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
    outDir: {
      type: 'string',
    },
    sourcemap: {
      type: 'boolean',
    },
    stub: {
      type: 'boolean',
    },
  },
  async run(context) {
    const { build } = await import('unbuild')

    const cwd = resolve(context.args.cwd || context.args.rootDir || '.')

    const outDir = context.args.outDir || 'dist'

    await build(cwd, false, {
      declaration: true,
      sourcemap: context.args.sourcemap,
      stub: context.args.stub,
      outDir,
      entries: [
        'src/module',
        { input: 'src/runtime/', outDir: `${outDir}/runtime`, ext: 'mjs' },
      ],
      rollup: {
        esbuild: {
          target: 'esnext',
        },
        emitCJS: false,
        cjsBridge: true,
      },
      externals: [
        '@nuxt/schema',
        '@nuxt/schema-nightly',
        '@nuxt/schema-edge',
        '@nuxt/kit',
        '@nuxt/kit-nightly',
        '@nuxt/kit-edge',
        'nuxt',
        'nuxt-nightly',
        'nuxt-edge',
        'nuxt3',
        'vue',
        'vue-demi',
      ],
      hooks: {
        async 'rollup:done'(ctx) {
        // Generate CommonJS stub
          await writeCJSStub(ctx.options.outDir)

          // Load module meta
          const moduleEntryPath = resolve(ctx.options.outDir, 'module.mjs')
          const moduleFn: NuxtModule<unknown> = await import(
            pathToFileURL(moduleEntryPath).toString()
          ).then(r => r.default || r).catch((err) => {
            consola.error(err)
            consola.error('Cannot load module. Please check dist:', moduleEntryPath)
            return null
          })

          if (!moduleFn) {
            return
          }
          const moduleMeta = await moduleFn.getMeta?.() || {}

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
        },
      },
    })
  },
})

async function writeTypes(distDir: string, meta: ModuleMeta) {
  const dtsFile = resolve(distDir, 'types.d.ts')
  const dtsFileMts = resolve(distDir, 'types.d.mts')
  if (existsSync(dtsFile)) {
    return
  }

  // Read generated module types
  const moduleTypesFile = resolve(distDir, 'module.d.ts')
  const moduleTypes = await fsp.readFile(moduleTypesFile, 'utf8').catch(() => '')
  const typeExports = findExports(
    // Replace `export { type Foo }` with `export { Foo }`
    moduleTypes
      .replace(/export\s*{.*?}/sg, match =>
        match.replace(/\btype\b/g, ''),
      ),
  )
  const isStub = moduleTypes.includes('export *')

  const appShims = []
  const schemaShims = []
  const moduleImports = []

  const hasTypeExport = (name: string) => isStub || typeExports.find(exp => exp.names.includes(name))

  if (meta.configKey && hasTypeExport('ModuleOptions')) {
    moduleImports.push('ModuleOptions')
    schemaShims.push(`  interface NuxtConfig { ['${meta.configKey}']?: Partial<ModuleOptions> }`)
    schemaShims.push(`  interface NuxtOptions { ['${meta.configKey}']?: ModuleOptions }`)
  }
  if (hasTypeExport('ModuleHooks')) {
    moduleImports.push('ModuleHooks')
    schemaShims.push('  interface NuxtHooks extends ModuleHooks {}')
  }

  if (hasTypeExport('ModuleRuntimeHooks')) {
    const runtimeHooksInterfaces = []

    if (hasTypeExport('ModuleRuntimeHooks')) {
      runtimeHooksInterfaces.push('ModuleRuntimeHooks')
    }

    moduleImports.push(...runtimeHooksInterfaces)
    appShims.push(`  interface RuntimeNuxtHooks extends ${runtimeHooksInterfaces.join(', ')} {}`)
  }

  if (hasTypeExport('ModuleRuntimeConfig')) {
    moduleImports.push('ModuleRuntimeConfig')
    schemaShims.push('  interface RuntimeConfig extends ModuleRuntimeConfig {}')
  }
  if (hasTypeExport('ModulePublicRuntimeConfig')) {
    moduleImports.push('ModulePublicRuntimeConfig')
    schemaShims.push('  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}')
  }

  const dtsContents = `
import type { ${moduleImports.join(', ')} } from './module'

${appShims.length ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module 'nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}

export type { ${typeExports[0].names.join(', ')} } from './module'
`

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
  if (!existsSync(dtsFileMts)) {
    await fsp.writeFile(dtsFileMts, dtsContents.replaceAll('./module', './module.js'), 'utf8')
  }
}

async function writeCJSStub(distDir: string) {
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
