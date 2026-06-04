import { existsSync, promises as fsp } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename, dirname, extname, isAbsolute, normalize, relative, resolve } from 'pathe'
import { filename } from 'pathe/utils'
import { readPackageJSON } from 'pkg-types'
import { parse } from 'tsconfck'
import { defu } from 'defu'
import { createJiti } from 'jiti'
import { consola } from 'consola'
import type { NuxtModule } from '@nuxt/schema'
import { findExports, resolvePath, findTypeExports, resolveModuleExportNames } from 'mlly'
import type { ESMExport } from 'mlly'
import { defineCommand } from 'citty'

import { name, version } from '../../package.json'
import { resolveCwdArg, sharedArgs } from './_shared'
import type { CompilerOptions } from 'typescript'
import type { Plugin } from 'rolldown'

export default defineCommand({
  meta: {
    name: 'build',
    description: 'Build module for distribution',
  },
  args: {
    ...sharedArgs,
    outDir: {
      type: 'string',
      default: 'dist',
      description: 'Build directory',
    },
    sourcemap: {
      type: 'boolean',
      default: false,
      description: 'Generate sourcemaps',
    },
    stub: {
      type: 'boolean',
      default: false,
      description: 'Stub dist instead of actually building it for development',
    },
  },
  async run(context) {
    const cwd = resolveCwdArg(context.args)
    const jiti = createJiti(cwd)
    const outDir = context.args.outDir
    const distDir = resolve(cwd, outDir)
    const srcRuntimeDir = resolve(cwd, 'src/runtime')
    const distRuntimeDir = resolve(distDir, 'runtime')

    // Detect entry points from package.json exports
    const moduleEntries = await inferModuleEntries(cwd)

    if (context.args.stub) {
      await fsp.rm(distDir, { recursive: true, force: true })
      await buildStub(cwd, distDir, moduleEntries)
      await writeTypes(distDir, true)
      return
    }

    const { build } = await import('rolldown')
    const { dts } = await import('rolldown-plugin-dts')
    const { vueSfcPlugin } = await import('vue-sfc-transformer/rolldown')
    const { glob } = await import('tinyglobby')

    // Clean dist directory before building
    await fsp.rm(distDir, { recursive: true, force: true })
    await fsp.mkdir(distDir, { recursive: true })

    // Load TypeScript compiler options (raw JSON for rolldown-plugin-dts)
    const tsOptions = await loadTSCompilerOptions(moduleEntries[0] || resolve(cwd, 'src/module.ts'))
    const compilerOptions = defu({
      noEmit: false,
      paths: {
        '#app/nuxt': ['./node_modules/nuxt/dist/app/nuxt'],
      },
    }, tsOptions)

    // Step 1: Build runtime JS (Vue SFCs handled as assets + TS/TSX files)
    if (existsSync(srcRuntimeDir)) {
      const runtimeTsFiles = await glob('**/*.{ts,tsx}', {
        cwd: srcRuntimeDir,
        absolute: true,
        ignore: ['**/*.stories.{ts,tsx}', '**/*.{spec,test}.{ts,tsx}'],
      })
      if (runtimeTsFiles.length > 0) {
        await build({
          cwd,
          input: Object.fromEntries(
            runtimeTsFiles.map(f => [relative(srcRuntimeDir, f).replace(/\.[cm]?tsx?$/, ''), f]),
          ),
          external: (id: string) => !id.startsWith('.') && !isAbsolute(id),
          preserveEntrySignatures: 'strict',
          plugins: [
            vueSfcPlugin({ srcDir: srcRuntimeDir, emitLegacyDeclarationAlias: true }),
            dts({ compilerOptions, cwd }),
          ],
          transform: {
            jsx: { runtime: 'automatic', importSource: 'vue' },
          },
          output: {
            format: 'esm',
            dir: distRuntimeDir,
            entryFileNames: '[name].js',
            chunkFileNames: '[name].js',
          },
        })
      }
    }

    // Step 2: Build module JS + DTS entries
    const moduleInput = Object.fromEntries(
      moduleEntries.map(e => [filename(e) || basename(e, extname(e)), e]),
    )
    const runtimeExternalsPlugin = createRuntimeExternalsPlugin(srcRuntimeDir)
    await build({
      cwd,
      input: moduleInput,
      external: [
        /dist[\\/]runtime[\\/]/,
        '@nuxt/schema',
        '@nuxt/schema-nightly',
        '@nuxt/schema-edge',
        '@nuxt/kit',
        '@nuxt/kit-nightly',
        '@nuxt/kit-edge',
        '#app',
        '#app/nuxt',
        'nuxt',
        'nuxt-nightly',
        'nuxt-edge',
        'nuxt3',
        'vue',
        'vue-demi',
      ],
      preserveEntrySignatures: 'strict',
      plugins: [
        runtimeExternalsPlugin,
        dts({ compilerOptions, cwd }),
      ],
      output: {
        format: 'esm',
        dir: distDir,
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name].mjs',
        sourcemap: context.args.sourcemap,
      },
    })

    // Step 3: Generate module metadata
    const moduleEntryPath = resolve(distDir, 'module.mjs')
    const moduleFn = await jiti.import<NuxtModule<Record<string, unknown>>>(
      pathToFileURL(moduleEntryPath).toString(),
      { default: true },
    ).catch((err) => {
      consola.error(err)
      consola.error('Cannot load module. Please check dist:', moduleEntryPath)
      return null
    })

    if (!moduleFn) {
      return
    }
    const moduleMeta = await moduleFn.getMeta?.() || {}

    const pkg = await readPackageJSON(cwd)
    if (pkg) {
      if (!moduleMeta.name) {
        moduleMeta.name = pkg.name
      }
      if (!moduleMeta.version) {
        moduleMeta.version = pkg.version
      }
    }

    moduleMeta.builder = {
      [name]: version,
      rolldown: await readPackageJSON('rolldown').then(r => r.version).catch(() => 'unknown'),
    }

    await fsp.writeFile(resolve(distDir, 'module.json'), JSON.stringify(moduleMeta, null, 2), 'utf8')

    // Step 6: Generate types.d.mts
    await writeTypes(distDir, false)

    // Step 7: Build warnings
    const builtPkg = await readPackageJSON(cwd)
    if (builtPkg?.types && !existsSync(resolve(cwd, builtPkg.types))) {
      consola.warn(`Please remove the \`types\` field from package.json as it is no longer required for Bundler TypeScript module resolution. Instead, you can use \`typesVersions\` to support subpath export types for Node10, if required.`)
    }
  },
})

function createRuntimeExternalsPlugin(srcRuntimeDir: string): Plugin {
  const RUNTIME_RE = /[\\/]runtime[\\/]/
  const normalizedSrcDir = normalize(srcRuntimeDir)

  return {
    name: 'nuxt-module-builder:runtime-externals',
    async resolveId(this, id, importer) {
      if (!RUNTIME_RE.test(id))
        return

      const resolved = await this.resolve(id, importer, { skipSelf: true })
      if (!resolved)
        return

      const normalizedId = normalize(resolved.id)
      if (!normalizedId.startsWith(normalizedSrcDir))
        return

      // Map source file to its output .js path relative to dist dir
      const relInRuntime = relative(normalizedSrcDir, normalizedId).replace(/\.[cm]?tsx?$/, '')
      const distRelativePath = './runtime/' + relInRuntime.replace(/\\/g, '/') + '.js'

      return {
        external: true,
        id: distRelativePath,
      }
    },
  }
}

async function inferModuleEntries(cwd: string): Promise<string[]> {
  const entries: string[] = []

  // Always include src/module
  for (const ext of ['.ts', '.tsx', '.mts']) {
    const candidate = resolve(cwd, 'src/module' + ext)
    if (existsSync(candidate)) {
      entries.push(candidate)
      break
    }
  }

  const pkg = await readPackageJSON(cwd).catch(() => null)
  if (!pkg?.exports) return entries

  // Collect .mjs paths from package.json exports
  function collectMjs(obj: unknown): string[] {
    if (typeof obj === 'string') return obj.endsWith('.mjs') ? [obj] : []
    if (typeof obj === 'object' && obj !== null) {
      return Object.values(obj as Record<string, unknown>).flatMap(collectMjs)
    }
    return []
  }

  for (const mjsPath of collectMjs(pkg.exports)) {
    // './dist/utils.mjs' → 'src/utils'
    const match = mjsPath.match(/^\.\/dist\/(.+)\.mjs$/)
    if (!match) continue
    const srcBase = resolve(cwd, 'src', match[1]!)
    for (const ext of ['.ts', '.tsx', '.mts']) {
      const candidate = srcBase + ext
      if (existsSync(candidate) && !entries.includes(candidate)) {
        entries.push(candidate)
        break
      }
    }
  }

  return entries
}

async function buildStub(cwd: string, distDir: string, entries: string[]) {
  await fsp.mkdir(distDir, { recursive: true })

  const jitiPath = pathToFileURL(
    await resolvePath('jiti', { url: import.meta.url, conditions: ['node', 'import'] }),
  ).toString()

  for (const resolvedEntry of entries) {
    const entryName = filename(resolvedEntry) || basename(resolvedEntry, extname(resolvedEntry))
    const outBase = resolve(distDir, entryName)
    const srcUrl = pathToFileURL(resolvedEntry).toString()

    const exports = await resolveModuleExportNames(resolvedEntry, {
      extensions: ['.ts', '.tsx', '.mts'],
    }).catch(() => [] as string[])
    const hasDefaultExport = exports.includes('default')

    const mjsContent = [
      `import { createJiti } from ${JSON.stringify(jitiPath)};`,
      ``,
      `const jiti = createJiti(import.meta.url);`,
      ``,
      `/** @type {import(${JSON.stringify(srcUrl)})} */`,
      `const _module = await jiti.import(${JSON.stringify(srcUrl)});`,
      hasDefaultExport ? `export default _module?.default ?? _module;` : '',
      ...exports.filter(n => n !== 'default').map(n => `export const ${n} = _module.${n};`),
    ].filter(Boolean).join('\n') + '\n'

    await fsp.writeFile(outBase + '.mjs', mjsContent, 'utf8')

    const dtsContent = [
      `export * from ${JSON.stringify(srcUrl)};`,
      hasDefaultExport ? `export { default } from ${JSON.stringify(srcUrl)};` : '',
    ].filter(Boolean).join('\n') + '\n'

    await fsp.writeFile(outBase + '.d.mts', dtsContent, 'utf8')
  }
}

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
    for (const i of findTypeExports(normalisedModuleTypes)) {
      moduleReExports.push(i)
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
${moduleReExports.filter(e => e.type === 'named' || e.type === 'default').map(e => `\nexport { ${e.names.map(n => (n === 'default' ? '' : 'type ') + n).join(', ')} } from '${e.specifier || './module.mjs'}'`).join('\n')}
${moduleReExports.filter(e => e.type === 'star').map(e => `\nexport * from '${e.specifier || './module.mjs'}'`).join('\n')}
`.trim().replace(/[\n\r]{3,}/g, '\n\n') + '\n'

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
}

async function loadTSCompilerOptions(path: string): Promise<CompilerOptions> {
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
