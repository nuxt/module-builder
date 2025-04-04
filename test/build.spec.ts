import { fileURLToPath } from 'node:url'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { beforeAll, describe, it, expect } from 'vitest'
import { exec } from 'tinyexec'
import { readPackageJSON } from 'pkg-types'
import { dirname, join } from 'pathe'
import { findStaticImports } from 'mlly'
import { version } from '../package.json'

describe('module builder', () => {
  const rootDir = fileURLToPath(new URL('../example', import.meta.url))
  const secondRootDir = rootDir.replace('example', '.temp-example-without-options')
  const distDir = join(rootDir, 'dist')
  const secondDistDir = join(secondRootDir, 'dist')
  const runtimeDir = join(distDir, 'runtime')

  beforeAll(async () => {
    // Prepare second root directory without type export
    await mkdir(dirname(secondRootDir), { recursive: true })
    await rm(secondRootDir, { force: true, recursive: true })
    await cp(rootDir, secondRootDir, { recursive: true })
    const moduleSrc = join(secondRootDir, 'src/module.ts')
    const contents = await readFile(moduleSrc, 'utf-8').then(r => r.replace('export interface ModuleOptions', 'interface ModuleOptions'))
    await writeFile(moduleSrc, contents)

    await Promise.all([
      exec('pnpm', ['dev:prepare'], { nodeOptions: { cwd: rootDir } }).then(() => exec('pnpm', ['prepack'], { nodeOptions: { cwd: rootDir } })),
      exec('pnpm', ['dev:prepare'], { nodeOptions: { cwd: secondRootDir } }).then(() => exec('pnpm', ['prepack'], { nodeOptions: { cwd: secondRootDir } })),
    ])
  }, 120 * 1000)

  it('should generate all files', async () => {
    const files = await readdir(distDir)
    expect(files).toMatchInlineSnapshot(`
      [
        "module.d.mts",
        "module.json",
        "module.mjs",
        "runtime",
        "types.d.mts",
        "utils.d.mts",
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
    const types = await readFile(join(distDir, 'types.d.mts'), 'utf-8')
    expect(types).toMatchInlineSnapshot(`
      "import type { ModuleHooks, ModuleRuntimeHooks, ModuleRuntimeConfig, ModulePublicRuntimeConfig } from './module.mjs'

      declare module '#app' {
        interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}
      }

      declare module '@nuxt/schema' {
        interface NuxtHooks extends ModuleHooks {}
        interface RuntimeConfig extends ModuleRuntimeConfig {}
        interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}
      }

      export { default } from './module.mjs'

      export { type ModuleHooks, type ModuleOptions, type ModulePublicRuntimeConfig, type ModuleRuntimeConfig, type ModuleRuntimeHooks } from './module.mjs'
      "
    `)
  })

  it('should generate types when no ModuleOptions are exported', async () => {
    const types = await readFile(join(secondDistDir, 'types.d.mts'), 'utf-8')
    expect(types).toMatchInlineSnapshot(`
      "import type { NuxtModule } from '@nuxt/schema'

      import type { default as Module, ModuleHooks, ModuleRuntimeHooks, ModuleRuntimeConfig, ModulePublicRuntimeConfig } from './module.mjs'

      declare module '#app' {
        interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}
      }

      declare module '@nuxt/schema' {
        interface NuxtHooks extends ModuleHooks {}
        interface RuntimeConfig extends ModuleRuntimeConfig {}
        interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}
      }

      export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>

      export { default } from './module.mjs'

      export { type ModuleHooks, type ModulePublicRuntimeConfig, type ModuleRuntimeConfig, type ModuleRuntimeHooks } from './module.mjs'
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
    await expect(pluginDts).toMatchFileSnapshot('__snapshots__/plugin.d.ts')
  })

  it('should correctly add extensions to imports from runtime/ directory', async () => {
    const moduleDts = await readFile(join(distDir, 'module.d.mts'), 'utf-8')
    const runtimeImport = findStaticImports(moduleDts).find(i => i.specifier.includes('runtime'))
    expect(runtimeImport!.code.trim()).toMatchInlineSnapshot(`"import { SharedTypeFromRuntime } from '../dist/runtime/plugins/plugin.js';"`)
  })

  it('should generate components correctly', async () => {
    const componentFile = await readFile(join(distDir, 'runtime/components/TestMe.vue'), 'utf-8')
    await expect(componentFile.replace(/\r\n/g, '\n')).toMatchFileSnapshot('__snapshots__/TestMe.vue')

    const componentDeclarationFile = await readFile(join(distDir, 'runtime/components/TestMe.vue.d.ts'), 'utf-8')
    await expect(componentDeclarationFile.replace(/\r\n/g, '\n')).toMatchFileSnapshot('__snapshots__/TestMe.vue.d.ts')
  })

  it('should generate components with <script setup> correctly', async () => {
    const componentFile = await readFile(join(distDir, 'runtime/components/TestMeSetup.vue'), 'utf-8')
    await expect(componentFile.replace(/\r\n/g, '\n')).toMatchFileSnapshot('__snapshots__/TestMeSetup.vue')

    const componentDeclarationFile = await readFile(join(distDir, 'runtime/components/TestMeSetup.vue.d.ts'), 'utf-8')
    await expect(componentDeclarationFile.replace(/\r\n/g, '\n')).toMatchFileSnapshot('__snapshots__/TestMeSetup.vue.d.ts')
  })

  it('should generate wrapped composables', async () => {
    const componentFile = await readFile(join(distDir, 'runtime/composables/useWrappedFetch.d.ts'), 'utf-8')
    await expect(componentFile).toMatchFileSnapshot('__snapshots__/useWrappedFetch.d.ts')
  })

  it('should handle JSX correctly', async () => {
    const [component, declaration] = await Promise.all([
      readFile(join(distDir, 'runtime/components/JsxComponent.js'), 'utf-8'),
      readFile(join(distDir, 'runtime/components/JsxComponent.d.ts'), 'utf-8'),
    ])
    await expect(component).toMatchFileSnapshot('__snapshots__/JsxComponent.js')
    await expect(declaration).toMatchFileSnapshot('__snapshots__/JsxComponent.d.ts')
  })
})
