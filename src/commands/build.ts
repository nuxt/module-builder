import { existsSync, promises as fsp } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, dirname, join, resolve } from 'pathe'
import { filename } from 'pathe/utils'
import { readPackageJSON } from 'pkg-types'
import { parse } from 'tsconfck'
import type { TSConfig } from 'pkg-types'
import { defu } from 'defu'
import { anyOf, createRegExp } from 'magic-regexp'
import { consola } from 'consola'
import type { ModuleMeta, NuxtModule } from '@nuxt/schema'
import { findExports, resolvePath } from 'mlly'
import { resolveSchema, generateTypes } from 'untyped'
import type { InputObject } from 'untyped'
import { defineCommand } from 'citty'
import { loadNuxt } from '@nuxt/kit'

import { name, version } from '../../package.json'

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
        {
          input: 'src/runtime/',
          outDir: `${outDir}/runtime`,
          addRelativeDeclarationExtensions: true,
          ext: 'js',
          esbuild: {
            jsxImportSource: 'vue',
            jsx: 'automatic',
            jsxFactory: 'h',
          },
        },
      ],
      rollup: {
        esbuild: {
          target: 'esnext',
        },
        emitCJS: false,
        cjsBridge: true,
      },
      externals: [
        /dist\/runtime\//,
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
        async 'mkdist:entry:options'(_ctx, entry, options) {
          options.typescript = defu(options.typescript, {
            compilerOptions: await loadTSCompilerOptions(entry.input),
          })
        },
        async 'rollup:options'(ctx, options) {
          options.plugins ||= []
          if (!Array.isArray(options.plugins))
            options.plugins = [options.plugins]

          const runtimeEntries = ctx.options.entries.filter(entry => entry.builder === 'mkdist')

          const runtimeDirs = runtimeEntries.map(entry => basename(entry.input))
          const RUNTIME_RE = createRegExp(anyOf(...runtimeDirs).and('/'))

          // Add extension for imports of runtime files in build
          options.plugins.unshift({
            name: 'nuxt-module-builder:runtime-externals',
            async resolveId(id, importer) {
              if (!RUNTIME_RE.test(id))
                return

              const resolved = await this.resolve(id, importer, { skipSelf: true })
              if (!resolved)
                return

              for (const entry of runtimeEntries) {
                if (!resolved.id.includes(entry.input))
                  continue

                const distFile = await resolvePath(join(dirname(resolved.id.replace(entry.input, entry.outDir!)), filename(resolved.id)))
                if (distFile) {
                  return {
                    external: true,
                    id: distFile,
                  }
                }
              }
            },
          })
        },
        async 'rollup:done'(ctx) {
          // Generate CommonJS stub
          await writeCJSStub(ctx.options.outDir)

          // Load module meta
          const moduleEntryPath = resolve(ctx.options.outDir, 'module.mjs')
          const moduleFn: NuxtModule<Record<string, unknown>> = await import(
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

          // Add module builder metadata
          moduleMeta.builder = {
            [name]: version,
            unbuild: await readPackageJSON('unbuild').then(r => r.version).catch(() => 'unknown'),
          }

          // Write meta
          const metaFile = resolve(ctx.options.outDir, 'module.json')
          await fsp.writeFile(metaFile, JSON.stringify(moduleMeta, null, 2), 'utf8')

          // Generate types
          await writeTypes(ctx.options.outDir, moduleMeta, async () => {
            const nuxt = await loadNuxt({
              cwd,
              overrides: {
                modules: [resolve(cwd, './src/module')],
              },
            })
            const moduleOptions = await moduleFn.getOptions?.({}, nuxt) || {}
            await nuxt.close()
            return moduleOptions
          })
        },
      },
    })
  },
})

async function writeTypes(distDir: string, meta: ModuleMeta, getOptions: () => Promise<Record<string, unknown>>) {
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
      .replace(/export\s*\{.*?\}/gs, match =>
        match.replace(/\btype\b/g, ''),
      ),
  )
  const isStub = moduleTypes.includes('export *')

  const appShims: string[] = []
  const schemaShims: string[] = []
  const moduleImports: string[] = []
  const schemaImports: string[] = []
  const moduleExports: string[] = []

  const hasTypeExport = (name: string) => isStub || typeExports.find(exp => exp.names.includes(name))

  if (!hasTypeExport('ModuleOptions')) {
    schemaImports.push('NuxtModule')
    moduleImports.push('default as Module')
    moduleExports.push(`export type ModuleOptions = Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`)
  }

  if (hasTypeExport('ModuleHooks')) {
    moduleImports.push('ModuleHooks')
    schemaShims.push('  interface NuxtHooks extends ModuleHooks {}')
  }

  if (hasTypeExport('ModuleRuntimeHooks')) {
    const runtimeHooksInterfaces: string[] = []

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
  ${schemaImports.length ? `import type { ${schemaImports.join(', ')} } from '@nuxt/schema'` : ''}

import type { ${moduleImports.join(', ')} } from './module'

${appShims.length ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module 'nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length ? `\n${moduleExports.join('\n')}` : ''}
${typeExports[0] ? `\nexport type { ${typeExports[0].names.join(', ')} } from './module'` : ''}
`.trim().replace(/[\n\r]{3,}/g, '\n\n')

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
  if (!existsSync(dtsFileMts)) {
    await fsp.writeFile(dtsFileMts, dtsContents.replace(/\.\/module/g, './module.js'), 'utf8')
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

async function loadTSCompilerOptions(path: string): Promise<NonNullable<TSConfig['compilerOptions']>> {
  const config = await parse(path)
  const resolvedCompilerOptions = config?.tsconfig.compilerOptions || {}

  // TODO: this should probably be ported to tsconfck?
  for (const { tsconfig, tsconfigFile } of config.extended || []) {
    for (const alias in tsconfig.compilerOptions?.paths || {}) {
      resolvedCompilerOptions.paths[alias] = resolvedCompilerOptions.paths[alias].map((p: string) => {
        if (!/^\.{1,2}(?:\/|$)/.test(p)) return p

        return resolve(dirname(tsconfigFile), p)
      })
    }
  }

  return resolvedCompilerOptions
}
