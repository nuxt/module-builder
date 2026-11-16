import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'pathe'
import { exec } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { builderImport, copyExample, exampleDir, repoRoot, tsdown } from './utils.ts'

describe('with a root tsconfig that only lists references', () => {
  const references = (node: string) => ({
    files: [],
    exclude: ['dist', 'node_modules', 'playground'],
    references: [node, './.nuxt/tsconfig.app.json', './.nuxt/tsconfig.server.json', './.nuxt/tsconfig.shared.json'].map(path => ({ path })),
  })

  it('should generate tsconfigs for the module entry, without the playground or the workspace, and with app aliases for module code', async () => {
    const dir = await copyExample('.temp-tsdown-references-prepare', 'export default { plugins: [builder()] }\n')
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.options.json', files: [], references: [{ path: './tsconfig.module.json' }] }))
    await writeFile(join(dir, 'tsconfig.options.json'), JSON.stringify({ compilerOptions: { types: ['vitest/importMeta'] }, exclude: ['dist', 'node_modules', 'playground'] }))
    await writeFile(join(dir, 'tsconfig.module.json'), JSON.stringify({ extends: './tsconfig.base.json' }))
    await writeFile(join(dir, 'tsconfig.base.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node' }))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    expect((await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })).exitCode).toBe(0)
    const generated = async (name: string) => JSON.parse(await readFile(join(dir, `.nuxt/tsconfig.${name}.json`), 'utf-8'))
    const [node, app] = [await generated('node'), await generated('app')]
    expect(node.include).toContain('../src/*.ts')
    expect(node.compilerOptions.paths['#app']).toBeDefined()
    expect(node.compilerOptions.types).toContain('vitest/importMeta')
    expect(node.compilerOptions.paths['#components']).toBeDefined()
    expect(app.exclude).toContain('../playground')
    expect(app.include).not.toContain('../../**/*')
    expect(app.include).toContain('../src/runtime')
    for (const name of ['app', 'node', 'server', 'shared']) {
      const { include, exclude } = await generated(name)
      expect([...include, ...exclude].filter((pattern: string) => pattern.startsWith('../src/dist')), name).toEqual([])
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('should type runtime components with their own context and pass the type check', async () => {
    const dir = await copyExample('.temp-tsdown-references-contexts', 'export default { plugins: [builder()] }\n')
    const moduleSrc = join(dir, 'src/module.ts')
    await writeFile(moduleSrc, (await readFile(moduleSrc, 'utf-8'))
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addImports, addTemplate, addTypeTemplate, createResolver } from \'@nuxt/kit\'\nimport { moduleHelper } from \'./helpers/name.ts\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    _nuxt.options.alias[\'#my-types\'] = resolver.resolve(\'./runtime/types\')\n    addImports({ name: \'useThing\', from: resolver.resolve(\'./runtime/composables/useThing\') })\n    addTypeTemplate({ filename: \'module/my-module-names.d.ts\', getContents: () => \'declare module "#my-module/names" {\\n  export const names: string[]\\n}\\n\' }, { nuxt: false })\n    _nuxt.hook(\'prepare:types\', ({ tsConfig }) => { tsConfig.include?.push(\'./module/my-module-names.d.ts\') })\n    addTemplate({ filename: \'my-module-virtual.mjs\', getContents: () => \'export default 1\\n\' })\n    moduleHelper()'))
    await mkdir(join(dir, 'src/helpers'), { recursive: true })
    await mkdir(join(dir, 'src/runtime/types'), { recursive: true })
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    await mkdir(join(dir, 'test/fixture'), { recursive: true })
    await mkdir(join(dir, 'types'), { recursive: true })
    await Promise.all([
      writeFile(join(dir, 'types/virtual.d.ts'), `declare module '#my-root-virtual' {\n  export const rootValue: string\n}\n`),
      writeFile(join(dir, 'content.d.ts'), `export * from './dist/content'\n`),
      writeFile(join(dir, 'src/helpers/name.ts'), `import { useNuxt } from '@nuxt/kit'\n\nexport type { Linked } from '../runtime/linked.ts'\nexport type Jsx = typeof import('../runtime/components/JsxComponent.tsx').default\nexport type Names = ReturnType<typeof import('../runtime/composables/useNames.ts').useNames>\n\nexport function moduleHelper(): unknown {\n  return import.meta.vitest ? undefined : useNuxt().options.myModule\n}\n\nexport const callInit = (): unknown => useNuxt().callHook('my-module:init', 'shared-type')\n`),
      writeFile(join(dir, 'src/runtime/composables/useVirtual.ts'), `import value from '#build/my-module-virtual'\n\nexport const useVirtual = (): unknown => value\n`),
      writeFile(join(dir, 'src/runtime/composables/useNames.ts'), `import { names } from '#my-module/names'\n\nexport const useNames = (): string[] => names\n`),
      writeFile(join(dir, 'src/runtime/linked.ts'), `import type { NuxtLink } from '#components'\n\nexport type Linked = typeof NuxtLink\n`),
      writeFile(join(dir, 'src/env.d.ts'), `declare const __MY_MODULE_FLAG__: boolean\n`),
      writeFile(join(dir, 'ambient.d.ts'), `declare module '#my-virtual' {\n  export const virtualValue: string\n}\n`),
      writeFile(join(dir, 'src/runtime/server/virtual.ts'), `import { virtualValue } from '#my-virtual'\nimport { rootValue } from '#my-root-virtual'\n\nexport const value: string = import.meta.vitest ? '' : virtualValue + rootValue\n`),
      writeFile(join(dir, 'src/augments.d.ts'), `declare module '#app' {\n  interface NuxtApp {\n    $thing: 'thing'\n  }\n}\n\nexport {}\n`),
      writeFile(join(dir, 'src/runtime/composables/useAppThing.ts'), `import { useNuxtApp } from '#app'\n\nexport const useAppThing = (): 'thing' | undefined => import.meta.vitest ? undefined : useNuxtApp().$thing\n`),
      writeFile(join(dir, 'src/runtime/types/index.ts'), `export type Trigger = 'onNuxtReady' | string[] | boolean\n`),
      writeFile(join(dir, 'src/runtime/composables/useThing.ts'), `export function useThing() {\n  return { loggedIn: __MY_MODULE_FLAG__, user: null as { name: string } | null }\n}\n`),
      writeFile(join(dir, 'src/runtime/components/Triggered.vue'), `<script setup lang="ts">\nimport type { Trigger } from '#my-types'\n\ndefineProps<{ trigger?: Trigger }>()\n</script>\n\n<template>\n  <div />\n</template>\n`),
      writeFile(join(dir, 'src/runtime/components/ThingState.vue'), `<script setup lang="ts">\nimport { useThing } from '#imports'\n\nconst { loggedIn, user } = useThing()\n</script>\n\n<template>\n  <slot v-bind="{ loggedIn, user }" />\n</template>\n`),
      writeFile(join(dir, 'test/fixture/nuxt.config.ts'), `export default defineNuxtConfig({})\n`),
      writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
        files: [],
        compilerOptions: { types: ['vitest/importMeta'] },
        exclude: ['dist', 'node_modules', 'playground'],
        references: ['./.nuxt/tsconfig.app.json', './.nuxt/tsconfig.server.json', './.nuxt/tsconfig.shared.json', './.nuxt/tsconfig.node.json'].map(path => ({ path })),
      })),
    ])
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(built.stdout + built.stderr).not.toContain('type error')
    expect(await readFile(join(dir, 'dist/runtime/components/ThingState.d.vue.ts'), 'utf-8')).toMatch(/loggedIn: boolean;\s+user: \{\s+name: string;\s+\} \| null;/)
    expect(await readFile(join(dir, 'dist/runtime/components/Triggered.vue'), 'utf-8')).toMatch(/type: \[\s*String,\s*Array,\s*Boolean\s*\]/)
    const generated = async (name: string) => JSON.parse(await readFile(join(dir, `.nuxt/tsconfig.${name}.json`), 'utf-8'))
    for (const name of ['app', 'node', 'server', 'shared']) {
      const config = await generated(name)
      expect(config.files, name).toEqual(expect.arrayContaining([join(dir, 'src/env.d.ts'), join(dir, 'ambient.d.ts'), join(dir, 'types/virtual.d.ts')]))
      expect(config.files, name).not.toContain(join(dir, 'src/augments.d.ts'))
      expect(config.compilerOptions.types, name).toContain('vitest/importMeta')
    }
    for (const name of ['nuxt', 'nuxt.node']) {
      expect(await readFile(join(dir, `.nuxt/${name}.d.ts`), 'utf-8'), name).toContain('/// <reference path="../src/augments.d.ts" />')
    }
    expect(await readFile(join(dir, '.nuxt/nuxt.shared.d.ts'), 'utf-8')).not.toContain('augments.d.ts')
    expect(await readFile(join(dir, '.nuxt/nuxt.node.d.ts'), 'utf-8')).toContain('/// <reference path="module-builder/types.d.mts" />')
    const buildTypes = (await readFile(join(dir, '.nuxt/types/build.d.ts'), 'utf-8')).split('\n')
    expect(buildTypes).toContain('declare module "#build/my-module-virtual";')
    expect(buildTypes).not.toContain('declare module "#build/my-module-virtual.mjs";')
    const app = await generated('app')
    expect(app.include).not.toContain('../**/*')
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-b', '--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout + typecheck.stderr).toBe('')
    await rm(dir, { recursive: true, force: true })
  }, 240 * 1000)

  it('should give tsdown the project that includes the module entry, unless the config sets `tsconfig`', async () => {
    const dir = await copyExample('.temp-tsdown-references', 'export default { plugins: [builder()] }\n')
    await writeFile(join(dir, 'tsconfig.module.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { erasableSyntaxOnly: true, useDefineForClassFields: false } }))
    await writeFile(join(dir, 'tsconfig.override.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { useDefineForClassFields: true } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./tsconfig.module.json')))
    await appendFile(join(dir, 'src/module.ts'), `\nclass Fields { value!: string }\nexport const ownsField: boolean = Object.hasOwn(new Fields(), 'value')\n`)
    const ownsField = async () => (await readFile(join(dir, 'dist/module.mjs'), 'utf-8')).includes('\tvalue;')
    const result = await tsdown(dir, [], { CI: '' })
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('tsconfig: tsconfig.module.json')
    expect(result.stdout).toMatch(/Set `?isolatedDeclarations: true`? in `?tsconfig\.module\.json`?/)
    expect(await ownsField()).toBe(false)
    const referencesDist = await readFile(join(dir, 'dist/module.d.mts'), 'utf-8')

    await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\nexport default { tsconfig: 'tsconfig.override.json', plugins: [builder()] }\n`)
    expect((await tsdown(dir)).stdout).toContain('tsconfig: tsconfig.override.json')
    expect(await ownsField()).toBe(true)

    await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\nexport default { plugins: [builder()] }\n`)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground'] }))
    const legacy = await tsdown(dir)
    expect(legacy.exitCode).toBe(0)
    expect(legacy.stdout).toContain('tsconfig: tsconfig.json')
    expect(await readFile(join(dir, 'dist/module.d.mts'), 'utf-8')).toBe(referencesDist)
    await rm(dir, { recursive: true, force: true })
  })

  it('should resolve the module\'s own package to declarations of module code in its app, server and shared tsconfigs', async () => {
    const dir = await copyExample('.temp-tsdown-references-own-package', 'export default { plugins: [builder()] }\n')
    const { exports, main, types, publishConfig } = JSON.parse(await readFile(join(exampleDir, 'package.json'), 'utf-8'))
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, exports, main, types, publishConfig, imports: { '#my-helpers': './src/helpers.ts' } }))
    await writeFile(join(dir, 'src/helpers.ts'), `export interface Helper {\n  name: string\n}\n`)
    await writeFile(join(dir, 'src/extra.d.ts'), `export interface Extra {\n  id: string\n}\n`)
    const moduleSrc = join(dir, 'src/module.ts')
    await writeFile(moduleSrc, (await readFile(moduleSrc, 'utf-8'))
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addTypeTemplate, createResolver } from \'@nuxt/kit\'\n\nexport type { Helper } from \'#my-helpers\'\nexport type { Extra } from \'./extra\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    addTypeTemplate({ filename: \'types/my-module.d.ts\', getContents: () => \'import type { ModuleOptions } from "my-module"\\ndeclare module "#app" {\\n  interface NuxtApp {\\n    $myModuleOptions: ModuleOptions\\n  }\\n}\\nexport {}\\n\' })\n    const configured: unknown = _nuxt.options.myModule\n    void configured'))
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    await mkdir(join(dir, 'shared'), { recursive: true })
    await writeFile(join(dir, 'shared/options.ts'), `import type { Extra, ModuleOptions } from 'my-module'\n\nexport const sharedApiKey = (options: ModuleOptions, extra: Extra): string => options.apiKey + extra.id\n// @ts-expect-error a string is not a number\nexport const extraId = (extra: Extra): number => extra.id\n`)
    await writeFile(join(dir, 'src/runtime/composables/useUtils.ts'), `import { myModuleUtils } from 'my-module/utils'\n\nexport const useUtils = (): () => void => myModuleUtils\n`)
    await writeFile(join(dir, 'src/runtime/server/options.ts'), `import type { ModuleOptions } from 'my-module'\n\nexport const apiKey = (options: ModuleOptions): string => options.apiKey\n`)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-b', '--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout + typecheck.stderr).toBe('')
    for (const name of ['app', 'server', 'shared']) {
      const listed = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-p', `.nuxt/tsconfig.${name}.json`, '--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })
      const files = listed.stdout.split('\n').map(file => file.trim())
      expect(files, name).not.toContain(join(dir, 'src/module.ts'))
      expect(files, name).not.toContain(join(dir, 'src/utils.ts'))
      expect(files, name).not.toContain(join(dir, 'src/helpers.ts'))
      expect(files, name).toContain(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))
    }
    const app = (await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-p', '.nuxt/tsconfig.app.json', '--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })).stdout
    expect(app).toContain(join(dir, '.nuxt/module-builder/declarations/src/utils.d.ts'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should write the declarations of module code with oxc when its tsconfig sets `isolatedDeclarations`', async () => {
    const dir = await copyExample('.temp-tsdown-references-own-package-isolated', 'export default { plugins: [builder()] }\n')
    await mkdir(join(dir, 'src/nested'), { recursive: true })
    await writeFile(join(dir, 'src/nested/payload.ts'), `export interface Payload {\n  value: string\n}\n`)
    await writeFile(join(dir, 'src/nested/shape.ts'), `export interface Shape {\n  sides: number\n}\n`)
    await writeFile(join(dir, 'src/utils.ts'), `export const myModuleUtils = (): void => {}\n`)
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, imports: { '#payload': './src/nested/payload.ts' } }))
    await writeFile(join(dir, 'src/module.ts'), [
      `import { defineNuxtModule } from '@nuxt/kit'`,
      `import type { NuxtModule } from '@nuxt/schema'`,
      `import type { Payload } from '#payload'`,
      `import type { Shape } from './nested/shape.ts'`,
      ``,
      `export interface ModuleOptions {\n  payload?: Payload\n  shape?: Shape\n}`,
      ``,
      `const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({ meta: { name: 'my-module', configKey: 'myModule' } })`,
      ``,
      `export default module`,
      ``,
    ].join('\n'))
    await writeFile(join(dir, 'src/runtime/composables/usePayload.ts'), `import type { ModuleOptions } from 'my-module'\n\nexport const usePayload = (options: ModuleOptions): string | undefined => options.payload?.value\n`)
    await writeFile(join(dir, 'tsconfig.module.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { isolatedDeclarations: true, declaration: true, allowJs: false } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./tsconfig.module.json')))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    expect(prepared.stdout + prepared.stderr).not.toContain('The build reports the same errors')
    expect(await readFile(join(dir, '.nuxt/module-builder/declarations/src/nested/payload.d.ts'), 'utf-8')).toContain('interface Payload')
    const moduleDeclaration = await readFile(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'), 'utf-8')
    expect(moduleDeclaration).toContain('from "./nested/payload.js"')
    expect(moduleDeclaration).toContain('from "./nested/shape.js"')
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-b', '--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout + typecheck.stderr).toBe('')
    const listed = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-p', '.nuxt/tsconfig.app.json', '--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })
    expect(listed.stdout).toContain(join(dir, '.nuxt/module-builder/declarations/src/nested/payload.d.ts'))
    expect(listed.stdout).not.toContain(join(dir, 'src/nested/payload.ts'))
    expect(listed.stdout).not.toContain(join(dir, 'src/nested/shape.ts'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should warn about a declaration error in module code at prepare, and write the other declarations', async () => {
    const dir = await copyExample('.temp-tsdown-references-own-package-error', 'export default { plugins: [builder()] }\n')
    const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`
    const files = {
      [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
      'src/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n`,
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true })
      await writeFile(join(dir, file), contents)
    }
    await symlink(join(dir, store('fake-logger')), join(dir, 'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger'))
    await symlink(join(dir, store('fake-shared')), join(dir, 'node_modules/fake-shared'))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')))
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    expect(prepared.stdout + prepared.stderr).toContain('The build reports the same errors')
    expect(prepared.stdout + prepared.stderr).toContain('src/logger.ts(3,14): error TS2883')
    expect(existsSync(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))).toBe(true)
    expect(existsSync(join(dir, '.nuxt/module-builder/declarations/types.d.mts'))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('should keep `.nuxt/tsconfig.json` one program over the module\'s sources, with the generated tsconfigs adapted', async () => {
    const dir = await copyExample('.temp-tsdown-references-legacy-prepare', 'export default { plugins: [builder()] }\n')
    const moduleSrc = join(dir, 'src/module.ts')
    await writeFile(moduleSrc, (await readFile(moduleSrc, 'utf-8'))
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addTypeTemplate, createResolver } from \'@nuxt/kit\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    addTypeTemplate({ filename: \'types/my-module.d.ts\', getContents: () => \'import type { ModuleOptions } from "my-module"\\ndeclare module "#app" {\\n  interface NuxtApp {\\n    $myModuleOptions: ModuleOptions\\n  }\\n}\\nexport {}\\n\' })\n    const configured: unknown = _nuxt.options.myModule\n    void configured\n    void _nuxt.callHook(\'my-module:init\', \'shared-type\')'))
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    await writeFile(join(dir, 'src/runtime/server/options.ts'), `export const apiKey = (options: { apiKey: string }): string => options.apiKey\n`)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground', 'tsdown.config.ts', 'nuxt.config.ts'] }))
    await writeFile(join(dir, 'nuxt.config.ts'), `export default { buildDir: '.nuxt-custom' }\n`)
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const generated = async (name: string) => JSON.parse(await readFile(join(dir, `.nuxt/${name}.json`), 'utf-8'))
    expect((await generated('tsconfig.app')).compilerOptions.paths['my-module']).toEqual(['./module-builder/declarations/types.d.mts'])
    const legacy = await generated('tsconfig')
    expect(legacy.compilerOptions.paths['my-module']).toBeUndefined()
    expect(legacy.include).not.toContain('./module-builder/declarations/types.d.mts')
    expect(legacy.exclude).not.toContain('../src/runtime/server')
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout).not.toMatch(/error TS5\d{3}/)
    expect(typecheck.stdout.split('\n').filter(line => /^(?:src|\.nuxt)\//.test(line))).toEqual([])
    const listed = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })
    expect(listed.stdout).toContain(join(dir, 'src/module.ts'))
    expect(listed.stdout).toContain(join(dir, 'src/runtime/server/options.ts'))
    expect(listed.stdout).not.toContain(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should name a dependency in runtime declarations by its package when only another part of the module imports it', async () => {
    const dir = await copyExample('.temp-tsdown-references-portable', 'export default { plugins: [builder()] }\n')
    const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`
    const files = {
      [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${store('fake-logger')}/index.js`]: `export const createLogger = () => ({ log: console.log })\n`,
      [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
      [`${store('fake-shared')}/index.js`]: `import { createLogger } from 'fake-logger'\nexport const createModuleLogger = () => createLogger()\n`,
      'src/runtime/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n`,
      'src/runtime/server/log.ts': `import { createLogger } from 'fake-logger'\n\nexport const serverLogger = createLogger()\n`,
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true })
      await writeFile(join(dir, file), contents)
    }
    await symlink(join(dir, store('fake-logger')), join(dir, 'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger'))
    for (const name of ['fake-logger', 'fake-shared']) {
      await symlink(join(dir, store(name)), join(dir, 'node_modules', name))
    }
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, 'fake-logger': '1.0.0', 'fake-shared': '1.0.0' } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')))
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(await readFile(join(dir, 'dist/runtime/logger.d.ts'), 'utf-8')).toContain('import("fake-logger").LoggerInstance')
    await rm(dir, { recursive: true, force: true })
  })

  it('should transform each runtime file with the referenced project that includes it', async () => {
    const dir = await copyExample('.temp-tsdown-references-transforms', 'export default { plugins: [builder()] }\n')
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    const source = `class Fields { value!: string }\nexport const ownsField: boolean = Object.hasOwn(new Fields(), 'value')\n`
    await writeFile(join(dir, 'src/runtime/fields.ts'), source)
    await writeFile(join(dir, 'src/runtime/server/fields.ts'), source)
    await writeFile(join(dir, 'tsconfig.server.json'), JSON.stringify({ extends: './.nuxt/tsconfig.server.json', compilerOptions: { useDefineForClassFields: false } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')).replace('./.nuxt/tsconfig.server.json', './tsconfig.server.json'))
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(await readFile(join(dir, 'dist/runtime/fields.js'), 'utf-8')).toContain('\tvalue;')
    expect(await readFile(join(dir, 'dist/runtime/server/fields.js'), 'utf-8')).not.toContain('value;')
    await rm(dir, { recursive: true, force: true })
  })
})
