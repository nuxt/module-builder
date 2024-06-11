import { fileURLToPath } from 'node:url'
import { readFile, readdir } from 'node:fs/promises'
import { beforeAll, describe, it, expect } from 'vitest'
import { execaCommand } from 'execa'
import { readPackageJSON } from 'pkg-types'
import { join } from 'pathe'
import { findStaticImports } from 'mlly'
import { version } from '../package.json'

describe('module builder', () => {
  const rootDir = fileURLToPath(new URL('../example', import.meta.url))
  const distDir = join(rootDir, 'dist')
  const runtimeDir = join(distDir, 'runtime')

  beforeAll(async () => {
    await execaCommand('pnpm dev:prepare', { cwd: rootDir })
    await execaCommand('pnpm prepack', { cwd: rootDir })
  }, 120 * 1000)

  it('should generate all files', async () => {
    const files = await readdir(distDir)
    expect(files).toMatchInlineSnapshot(`
      [
        "module.cjs",
        "module.d.mts",
        "module.d.ts",
        "module.json",
        "module.mjs",
        "runtime",
        "types.d.mts",
        "types.d.ts",
        "utils.d.mts",
        "utils.d.ts",
        "utils.mjs",
      ]
    `)

    const runtime = await readdir(join(runtimeDir, 'plugins'))
    expect(runtime).toMatchInlineSnapshot(`
      [
        "plugin.d.ts",
        "plugin.js",
      ]
    `)
  })

  it('should write types to output directory', async () => {
    const types = await readFile(join(distDir, 'types.d.ts'), 'utf-8')
    expect(types).toMatchInlineSnapshot(`
      "
      import type { ModuleOptions, ModuleHooks, ModuleRuntimeHooks, ModuleRuntimeConfig, ModulePublicRuntimeConfig } from './module'


      declare module '#app' {
        interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}
      }

      declare module '@nuxt/schema' {
        interface NuxtConfig { ['myModule']?: Partial<ModuleOptions> }
        interface NuxtOptions { ['myModule']?: ModuleOptions }
        interface NuxtHooks extends ModuleHooks {}
        interface RuntimeConfig extends ModuleRuntimeConfig {}
        interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}
      }

      declare module 'nuxt/schema' {
        interface NuxtConfig { ['myModule']?: Partial<ModuleOptions> }
        interface NuxtOptions { ['myModule']?: ModuleOptions }
        interface NuxtHooks extends ModuleHooks {}
        interface RuntimeConfig extends ModuleRuntimeConfig {}
        interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}
      }


      export type { ModuleHooks, ModuleOptions, ModulePublicRuntimeConfig, ModuleRuntimeConfig, ModuleRuntimeHooks, default } from './module'
      "
    `)
  })

  it('should generate module metadata as separate JSON file', async () => {
    const meta = await readFile(join(distDir, 'module.json'), 'utf-8')
    const unbuildPkg = await readPackageJSON('unbuild')
    expect(JSON.parse(meta)).toMatchObject(
      {
        builder: {
          '@nuxt/module-builder': version,
          'unbuild': unbuildPkg.version,
        },
        configKey: 'myModule',
        name: 'my-module',
        version: '1.0.0',
      },
    )
  })

  it('should generate typed plugin', async () => {
    const pluginDts = await readFile(join(distDir, 'runtime/plugins/plugin.d.ts'), 'utf-8')
    expect(pluginDts).toMatchFileSnapshot('__snapshots__/plugin.d.ts')
  })

  it('should correctly add extensions to imports from runtime/ directory', async () => {
    const moduleDts = await readFile(join(distDir, 'module.d.ts'), 'utf-8')
    const runtimeImport = findStaticImports(moduleDts).find(i => i.specifier.includes('runtime'))
    expect(runtimeImport!.code.trim()).toMatchInlineSnapshot(`"import { SharedTypeFromRuntime } from '../dist/runtime/plugins/plugin.js';"`)
  })

  // TODO: https://github.com/nuxt/module-builder/issues/239
  it('should generate components correctly', async () => {
    const componentFile = await readFile(join(distDir, 'runtime/components/TestMe.vue'), 'utf-8')
    expect(componentFile).toMatchFileSnapshot('__snapshots__/TestMe.vue')
  })

  it('should generate wrapped composables', async () => {
    const componentFile = await readFile(join(distDir, 'runtime/composables/useWrappedFetch.d.ts'), 'utf-8')
    expect(componentFile).toMatchFileSnapshot('__snapshots__/useWrappedFetch.d.ts')
  })

  it('should handle JSX correctly', async () => {
    const [component, declaration] = await Promise.all([
      readFile(join(distDir, 'runtime/components/JsxComponent.js'), 'utf-8'),
      readFile(join(distDir, 'runtime/components/JsxComponent.d.ts'), 'utf-8'),
    ])
    expect(component).toMatchFileSnapshot('__snapshots__/JsxComponent.js')
    expect(declaration).toMatchFileSnapshot('__snapshots__/JsxComponent.d.ts')
  })
})
