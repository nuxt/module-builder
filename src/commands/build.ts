import { existsSync, promises as fsp } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, dirname, join, normalize, resolve } from 'pathe'
import { filename } from 'pathe/utils'
import { readPackageJSON } from 'pkg-types'
import { parse } from 'tsconfck'
import type { TSConfig } from 'pkg-types'
import { defu } from 'defu'
import { createJiti } from 'jiti'
import { anyOf, createRegExp } from 'magic-regexp'
import { consola } from 'consola'
import type { NuxtModule } from '@nuxt/schema'
import { findExports, resolvePath } from 'mlly'
import type { ESMExport } from 'mlly'
import { defineCommand } from 'citty'

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

    const jiti = createJiti(cwd)
    const outDir = context.args.outDir || 'dist'

    await build(cwd, false, {
      declaration: 'node16',
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
        cjsBridge: false,
      },
      externals: [
        /dist[\\/]runtime[\\/]/,
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
          const RUNTIME_RE = createRegExp(anyOf(...runtimeDirs).and(anyOf('/', '\\')))

          // Add extension for imports of runtime files in build
          options.plugins.unshift({
            name: 'nuxt-module-builder:runtime-externals',
            async resolveId(id, importer) {
              if (!RUNTIME_RE.test(id))
                return

              const resolved = await this.resolve(id, importer, { skipSelf: true })
              if (!resolved)
                return

              const normalizedId = normalize(resolved.id)
              for (const entry of runtimeEntries) {
                if (!normalizedId.includes(entry.input))
                  continue

                const distFile = await resolvePath(join(dirname(pathToFileURL(normalizedId).href.replace(entry.input, entry.outDir!)), filename(normalizedId)))
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
          // Load module meta
          const moduleEntryPath = resolve(ctx.options.outDir, 'module.mjs')
          const moduleFn = await jiti.import<NuxtModule<Record<string, unknown>>>(pathToFileURL(moduleEntryPath).toString(), { default: true }).catch((err) => {
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
          await writeTypes(ctx.options.outDir, ctx.options.stub)
        },
        async 'build:done'(ctx) {
          const logs = [...ctx.warnings].filter(l => l.startsWith('Potential missing package.json files:'))
          if (logs.filter(l => l.match(/\.d\.ts/)).length > 0) {
            consola.warn(`\`@nuxt/module-builder\` no longer supports Node10 TypeScript module resolution and will no longer generate \`.d.ts\` declaration files. You can update these paths to use the \`.d.mts\` extension instead.`)
          }

          if (logs.filter(l => l.match(/module\.cjs/)).length > 0) {
            consola.warn(`\`@nuxt/module-builder\` will no longer generate \`module.cjs\` as this is not required for Nuxt v3+. You can safely remove replace this with \`module.mjs\` in your \`package.json\`.`)
          }

          const pkg = await readPackageJSON(cwd)
          if (pkg?.types && !existsSync(resolve(cwd, pkg.types))) {
            consola.warn(`Please remove the \`types\` field from package.json as it is no longer required for Bundler TypeScript module resolution.`)
          }
        },
      },
    })
  },
})

async function writeTypes(distDir: string, isStub: boolean) {
  const dtsFile = resolve(distDir, 'types.d.mts')
  if (existsSync(dtsFile)) {
    return
  }

  const moduleReExports: ESMExport[] = []
  if (!isStub) {
    // Read generated module types
    const moduleTypesFile = resolve(distDir, 'module.d.mts')
    const moduleTypes = await fsp.readFile(moduleTypesFile, 'utf8').catch(() => '')
    const normalisedModuleTypes = moduleTypes
      // Replace `export { type Foo }` with `export { Foo }`
      .replace(/export\s*\{.*?\}/gs, match => match.replace(/\b(type|interface)\b/g, ''))
    for (const e of findExports(normalisedModuleTypes)) {
      moduleReExports.push(e)
    }
  }

  const appShims: string[] = []
  const schemaShims: string[] = []
  const moduleImports: string[] = []
  const schemaImports: string[] = []
  const moduleExports: string[] = []

  const hasTypeExport = (name: string) => isStub || moduleReExports.find(exp => exp.names?.includes(name))

  if (!hasTypeExport('ModuleOptions')) {
    schemaImports.push('NuxtModule')
    moduleImports.push('default as Module')
    moduleExports.push(`export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`)
  }

  if (hasTypeExport('ModuleHooks')) {
    moduleImports.push('ModuleHooks')
    schemaShims.push('  interface NuxtHooks extends ModuleHooks {}')
  }

  if (hasTypeExport('ModuleRuntimeHooks')) {
    moduleImports.push('ModuleRuntimeHooks')
    appShims.push(`  interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}`)
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

${moduleImports.length ? `import type { ${moduleImports.join(', ')} } from './module.mjs'` : ''}

${appShims.length ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length ? `\n${moduleExports.join('\n')}` : ''}
${isStub ? 'export * from "./module.mjs"' : ''}
${moduleReExports[0] ? `\nexport { ${moduleReExports[0].names.map(n => (n === 'default' ? '' : 'type ') + n).join(', ')} } from './module.mjs'` : ''}
`.trim().replace(/[\n\r]{3,}/g, '\n\n') + '\n'

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
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
