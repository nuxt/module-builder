import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { beforeAll, describe, it, expect } from 'vitest'
import { exec } from 'tinyexec'
import { readPackageJSON } from 'pkg-types'
import { dirname, join, relative } from 'pathe'
import { findStaticImports } from 'mlly'
import { version as nuxtVersion } from 'nuxt/package.json'
import { satisfies } from 'verkit'
import { version } from '../package.json'
import { guide } from '../src/build/guide.ts'

const RUNTIME_IMPORTS = `
import { useWrappedFetch } from './runtime/composables/useWrappedFetch'
import { useAppFromNuxt } from '~~/src/runtime/composables/useAppNuxt'
import TestMe from './runtime/components/TestMe.vue'
export const runtimeRefs = [useWrappedFetch, useAppFromNuxt, TestMe]
export { useFetch, useNuxtApp as useApp } from '#app'
export { useNuxtApp as useDeepApp } from '#app/nuxt'
export { type NuxtApp, useRuntimeConfig } from '#app'
`

describe('module builder', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const rootDir = fileURLToPath(new URL('../example', import.meta.url))
  const secondRootDir = rootDir.replace('example', '.temp-example-without-options')
  const thirdRootDir = rootDir.replace('example', '.temp-example-with-runtime-imports')
  const fourthRootDir = rootDir.replace('example', '.temp-example-single-runtime-dir')
  const wildcardRootDir = rootDir.replace('example', '.temp-example-wildcard-paths')
  const noRuntimeRootDir = rootDir.replace('example', '.temp-example-without-runtime')
  const vueOnlyRootDir = rootDir.replace('example', '.temp-example-vue-only-runtime')
  const unpreparedRootDir = rootDir.replace('example', '.temp-example-unprepared')
  const jsSpecifierRootDir = rootDir.replace('example', '.temp-example-js-specifiers')
  const buildConfigRootDir = rootDir.replace('example', '.temp-example-build-config')
  const replaceRootDir = rootDir.replace('example', '.temp-example-build-config-replace')
  const unsupportedRootDir = rootDir.replace('example', '.temp-example-build-config-unsupported')
  const stylesheetsRootDir = rootDir.replace('example', '.temp-example-stylesheets')
  const transpileRootDir = rootDir.replace('example', '.temp-example-transpile-only')
  const solutionRootDir = rootDir.replace('example', '.temp-example-solution-tsconfig')
  const parentTsconfigRootDir = rootDir.replace('example', '.temp-example-parent-tsconfig')
  const portableRootDir = rootDir.replace('example', '.temp-example-portable-types')
  const isolatedRootDir = rootDir.replace('example', '.temp-example-isolated-declarations')
  const typeErrorRootDir = rootDir.replace('example', '.temp-example-type-error')
  const semanticErrorRootDir = rootDir.replace('example', '.temp-example-semantic-error')
  const vueErrorRootDir = rootDir.replace('example', '.temp-example-vue-error')
  const stubSyntaxRootDir = rootDir.replace('example', '.temp-example-stub-syntax')
  const annotatedRootDir = rootDir.replace('example', '.temp-example-isolated-annotated')
  const runtimeShapeRootDir = rootDir.replace('example', '.temp-example-runtime-shape')
  const routesRootDir = rootDir.replace('example', '.temp-example-routes/mod')
  let routesBuild = ''
  const encodedRootDir = rootDir.replace('example', '.temp-example with spaces ü')
  const distDir = join(rootDir, 'dist')
  const secondDistDir = join(secondRootDir, 'dist')
  const thirdDistDir = join(thirdRootDir, 'dist')
  const fourthDistDir = join(fourthRootDir, 'dist')
  const runtimeDir = join(distDir, 'runtime')

  beforeAll(async () => {
    const copyExample = async (target: string, transform: (contents: string) => string) => {
      await mkdir(dirname(target), { recursive: true })
      await rm(target, { force: true, recursive: true })
      await cp(rootDir, target, { recursive: true })
      const moduleSrc = join(target, 'src/module.ts')
      await writeFile(moduleSrc, transform(await readFile(moduleSrc, 'utf-8')))
    }

    // Prepare second root directory without type export
    await copyExample(secondRootDir, contents => contents.replace('export interface ModuleOptions', 'interface ModuleOptions'))

    // Prepare a root directory whose path is percent-encoded in file URLs
    await copyExample(encodedRootDir, contents => contents + RUNTIME_IMPORTS)

    // Prepare third root directory whose module entry pulls in runtime code, through a
    // relative specifier, a tsconfig alias and a `.vue` import
    await copyExample(thirdRootDir, contents => contents + RUNTIME_IMPORTS)

    // Prepare a fourth root directory whose entire runtime tree lives in one
    // subdirectory, and which contains no single-file components
    await copyExample(fourthRootDir, contents => contents)
    for (const directory of ['components', 'composables', 'assets']) {
      await rm(join(fourthRootDir, 'src/runtime', directory), { force: true, recursive: true })
    }

    const minimalModule = (name: string) => () => `import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  meta: { name: '${name}', configKey: '${name}' },
  setup() {},
})
`

    await copyExample(unpreparedRootDir, contents => contents)
    await rm(join(unpreparedRootDir, '.nuxt'), { force: true, recursive: true })

    await copyExample(jsSpecifierRootDir, contents => `${contents}\nexport { myModuleUtils } from './utils.js'\n`)

    await copyExample(noRuntimeRootDir, minimalModule('no-runtime'))
    await rm(join(noRuntimeRootDir, 'src/runtime'), { force: true, recursive: true })

    await copyExample(vueOnlyRootDir, minimalModule('vue-only'))
    for (const file of ['assets', 'composables', 'plugins', 'components/JsxComponent.tsx']) {
      await rm(join(vueOnlyRootDir, 'src/runtime', file), { force: true, recursive: true })
    }

    const enableIsolatedDeclarations = async (target: string) => {
      const tsconfig = join(target, 'tsconfig.json')
      await writeFile(tsconfig, JSON.stringify({ ...JSON.parse(await readFile(tsconfig, 'utf-8')), compilerOptions: { isolatedDeclarations: true } }))
    }

    await copyExample(isolatedRootDir, contents => contents)
    await enableIsolatedDeclarations(isolatedRootDir)

    await copyExample(stubSyntaxRootDir, contents => `import { name as packageName } from '../package.json'
import { Level } from './levels'

enum Mode { Stub = 'stub' }
class Holder { constructor(public value: string) {} }
${contents.replace(`name: 'my-module'`, 'name: new Holder(`${packageName}-${<string>Mode.Stub}-${Level.High}`).value')}`)
    const stubSyntaxPkg = JSON.parse(await readFile(join(stubSyntaxRootDir, 'package.json'), 'utf-8'))
    stubSyntaxPkg.exports['./plugin'] = './dist/runtime/plugins/plugin.js'
    await writeFile(join(stubSyntaxRootDir, 'package.json'), JSON.stringify(stubSyntaxPkg, null, 2))
    await writeFile(join(stubSyntaxRootDir, 'src/levels.ts'), `export enum Level { High = 'high' }\n`)

    await copyExample(typeErrorRootDir, contents => contents)
    await rm(join(typeErrorRootDir, 'src/runtime/components'), { recursive: true, force: true })
    await writeFile(join(typeErrorRootDir, 'src/runtime/utils.ts'), `export const Anonymous = class { private secret = 1 }\n`)
    await copyExample(semanticErrorRootDir, minimalModule('semantic-error'))
    await rm(join(semanticErrorRootDir, 'src/runtime'), { recursive: true, force: true })
    await mkdir(join(semanticErrorRootDir, 'src/runtime/utils'), { recursive: true })
    await writeFile(join(semanticErrorRootDir, 'src/runtime/utils/typo.ts'), `export const count: number = 'one'\nexport const double = (value: number): number => value * 2\n`)
    await mkdir(join(semanticErrorRootDir, 'src/runtime/components'), { recursive: true })
    await writeFile(join(semanticErrorRootDir, 'src/runtime/components/Typo.vue'), `<script setup lang="ts">\nconst props = defineProps<{ label: string }>()\nconst count: number = 'one'\n</script>\n\n<template>\n  <span>{{ props.label }} {{ count }}</span>\n</template>\n`)
    await writeFile(join(semanticErrorRootDir, 'src/runtime/components/Sized.vue'), `<script lang="ts">\nexport interface Props {\n  size?: 'xs' | 'sm' | 'md'\n}\n</script>\n\n<script setup lang="ts">\nconst props = defineProps<Props>()\n</script>\n\n<template>\n  <span :class="props.size" />\n</template>\n`)
    await mkdir(join(semanticErrorRootDir, 'src/runtime/composables'), { recursive: true })
    await writeFile(join(semanticErrorRootDir, 'src/runtime/composables/useSize.ts'), `import { computed } from 'vue'\nimport type { Props } from '../components/Sized.vue'\n\nexport function useSize(props: Props) {\n  return computed(() => props.size)\n}\n`)
    await copyExample(vueErrorRootDir, minimalModule('vue-error'))
    await rm(join(vueErrorRootDir, 'src/runtime'), { recursive: true, force: true })
    await copyExample(annotatedRootDir, contents => [
      `import type { NuxtModule } from '@nuxt/schema'`,
      contents.replace('export default defineNuxtModule<ModuleOptions>({', 'const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({'),
      'export default module',
    ].join('\n'))
    await writeFile(join(annotatedRootDir, 'src/utils.ts'), 'export const myModuleUtils = (): void => {}\n')
    await enableIsolatedDeclarations(annotatedRootDir)

    // Prepare a root directory whose tsconfig maps every bare specifier into `src/`,
    // with a file that shadows a real package
    await copyExample(wildcardRootDir, () => `import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  meta: { name: 'wildcard-module', configKey: 'wildcardModule' },
  setup() {},
})
`)
    await writeFile(join(wildcardRootDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '*': ['./src/*'] } } }, null, 2))
    await mkdir(join(wildcardRootDir, 'src/@nuxt'), { recursive: true })
    await writeFile(join(wildcardRootDir, 'src/@nuxt/kit.ts'), 'export const defineNuxtModule = (_: unknown) => ({ SHADOWED: true })\n')

    const writeFiles = async (target: string, files: Record<string, string>) => {
      for (const [file, contents] of Object.entries(files)) {
        await mkdir(dirname(join(target, file)), { recursive: true })
        await writeFile(join(target, file), contents)
      }
    }

    const fakeCache = {
      'node_modules/fake-cache/package.json': JSON.stringify({ name: 'fake-cache', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      'node_modules/fake-cache/index.js': `export const defineCached = handler => handler\n`,
      'node_modules/fake-cache/index.d.ts': `import type { Handler } from 'fake-h3'\nexport declare const defineCached: (handler: () => string) => Handler\n`,
      'node_modules/fake-cache/node_modules/fake-h3/package.json': JSON.stringify({ name: 'fake-h3', type: 'module', exports: { '.': { types: './index.d.ts' } } }),
      'node_modules/fake-cache/node_modules/fake-h3/index.d.ts': `export interface Handler { (): string, __h3: 2 }\n`,
    }
    await writeFiles(typeErrorRootDir, {
      ...fakeCache,
      'src/runtime/server/cached.ts': `import { defineCached } from 'fake-cache'\n\nexport const defineCachedHandler = defineCached(() => 'cached')\n`,
    })
    await writeFiles(vueErrorRootDir, {
      ...fakeCache,
      'src/runtime/components/Cached.vue': `<script lang="ts">\nimport { defineCached } from 'fake-cache'\n\nexport const cachedHandler = defineCached(() => 'cached')\nexport default {}\n</script>\n\n<template>\n  <span>cached</span>\n</template>\n`,
      'src/runtime/server/cached.ts': `import { defineCached } from 'fake-cache'\n\nexport const defineCachedHandler = defineCached(() => 'cached')\n`,
    })

    await copyExample(buildConfigRootDir, contents => contents)
    await writeFiles(buildConfigRootDir, {
      'build.config.ts': `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineBuildConfig } from '@nuxt/module-builder'
import { externals } from './build/externals'

const record = hook => ctx => appendFileSync(join(ctx.options.rootDir, 'hooks.log'), JSON.stringify({
  hook,
  stub: ctx.options.stub,
  meta: existsSync(join(ctx.options.outDir, 'module.json')),
  entries: ctx.options.entries.map(entry => entry.name).sort(),
}) + '\\n')

export default defineBuildConfig({
  hooks: {
    'build:before'(ctx) {
      record('build:before')(ctx)
      writeFileSync(join(ctx.options.rootDir, 'src/generated.ts'), 'export const generated = "from build:before"\\n')
    },
    'rollup:done': record('rollup:done'),
    'build:done': record('build:done'),
  },
  declaration: true,
  entries: [
    'src/utils',
    './src/vite.ts',
    { input: 'src/content', name: 'content' },
    'src/nested/helper',
    { input: 'src/shared/', outDir: 'dist/shared' },
  ],
  externals,
  replace: {
    __MODULE_VERSION__: JSON.stringify('1.2.3'),
  },
  rollup: {
    emitCJS: false,
  },
})
`,
      'build/externals.ts': `export const externals = ['fake-pkg', '#content-alias', /^regex-pkg$/]\n`,
      'node_modules/fake-pkg/package.json': JSON.stringify({ name: 'fake-pkg', type: 'module', exports: { './sub': './sub.js' } }),
      'node_modules/fake-pkg/sub.js': `export const plugin = 'bundled-fake-pkg'\n`,
      'node_modules/regex-pkg/package.json': JSON.stringify({ name: 'regex-pkg', type: 'module', exports: './index.js' }),
      'node_modules/regex-pkg/index.js': `export default 'bundled-regex-pkg'\n`,
      'src/alias/config.ts': `export default 'bundled-alias'\n`,
      'src/vite.ts': `// @ts-ignore untyped
import { plugin } from 'fake-pkg/sub'
// @ts-ignore untyped
import virtual from 'regex-pkg'

import { generated } from './generated'

declare const __MODULE_VERSION__: string

export const version: string = __MODULE_VERSION__
export const refs: unknown[] = [plugin, virtual, generated]
`,
      'src/content.ts': `// @ts-ignore build-time alias
import config from '#content-alias/config'

export const content: unknown = config
`,
      'src/nested/helper.ts': `import plugin from '../runtime/plugins/plugin'\n\nexport const helper = (): unknown => plugin\nexport const lazy = (): Promise<unknown> => import('../runtime/composables/useWrappedFetch')\n`,
      'src/shared/format.ts': `export const format = (value: string): string => value.trim()\n`,
      'src/features/flag.ts': `export const flag: boolean = true\n`,
    })

    const buildConfigPkg = join(buildConfigRootDir, 'package.json')
    await writeFile(buildConfigPkg, JSON.stringify({
      ...JSON.parse(await readFile(buildConfigPkg, 'utf-8')),
      imports: { '#content-alias/*': './src/alias/*.ts' },
      build: { entries: [{ input: 'src/features/', outDir: 'dist/features', ext: 'js' }] },
    }))

    await copyExample(replaceRootDir, contents => contents)
    await writeFiles(replaceRootDir, {
      'build.config.ts': `import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['./src/unplugin'],
  externals: ['#build/ui'],
  hooks: {
    'mkdist:entry:options'(ctx, entry, options) {
      options.addRelativeDeclarationExtensions = false
    },
  },
  rollup: {
    replace: {
      delimiters: ['', ''],
      values: {
        "process.argv.includes('--uiDev')": 'false',
      },
    },
  },
})
`,
      'src/unplugin.ts': `// @ts-ignore untyped
import ext from 'ext-pkg'

declare const process: { argv: string[] }

export const isDev: boolean = process.argv.includes('--uiDev')
export const extRef: unknown = ext
`,
      'node_modules/ext-pkg/package.json': JSON.stringify({ name: 'ext-pkg', type: 'module', exports: './index.js' }),
      'node_modules/ext-pkg/index.js': `export default 'bundled-ext-pkg'\n`,
    })
    const replacePkg = join(replaceRootDir, 'package.json')
    await writeFile(replacePkg, JSON.stringify({ ...JSON.parse(await readFile(replacePkg, 'utf-8')), unbuild: { externals: ['ext-pkg'] } }))

    await copyExample(unsupportedRootDir, contents => contents)
    await writeFiles(unsupportedRootDir, {
      'build.config.ts': `import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: [
    { input: 'src/runtime/', ext: 'cjs' },
    { input: 'src/schema', builder: 'untyped' },
  ],
  hooks: {
    'build:prepare'() {},
    'rollup:options'() {},
    'mkdist:entry:options'() {},
  },
  rollup: {
    emitCJS: true,
    alias: {},
  },
  stub: true,
  unknownOption: 1,
})
`,
    })

    await copyExample(transpileRootDir, contents => `import type { DeepPartial } from 'fake-types'
import type FakeCjs from 'fake-cjs-types'
${contents}
export interface ExtraOptions { deep?: DeepPartial<{ a: string }>, cjs?: FakeCjs.Options }
`)
    await writeFiles(transpileRootDir, {
      'node_modules/fake-cjs-types/package.json': JSON.stringify({ name: 'fake-cjs-types', types: './index.d.ts' }),
      'node_modules/fake-cjs-types/index.d.ts': `declare namespace FakeCjs { interface Options { level: number } }\nexport = FakeCjs\n`,
      'src/runtime/server/routes/[...slug].ts': `export default (slug: string) => slug\n`,
      'src/runtime/utils/self.ts': `import type { ModuleOptions } from 'my-module'\n\nexport const getApiKey = (options: ModuleOptions) => options.apiKey\n`,
      'node_modules/fake-dep/package.json': JSON.stringify({ name: 'fake-dep', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      'node_modules/fake-dep/index.js': `export const helper = () => 'bundled-fake-dep'\n`,
      'node_modules/fake-dep/index.d.ts': `export declare const helper: () => string\n`,
      'node_modules/fake-types/package.json': JSON.stringify({ name: 'fake-types', types: './index.d.ts' }),
      'node_modules/fake-types/index.d.ts': `export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> }\n`,
      'src/runtime/cache/lru.ts': `export const lru: string = 'lru'\n`,
      'src/runtime/server/handler.ts': `// @ts-ignore build-time virtual
import options from '#internal/nuxt.config.mjs'
// @ts-ignore app alias
import app from '~/app.config'
// @ts-ignore app alias
import root from '@/root'
import { useNuxtApp } from '#app'
import { helper } from 'fake-dep'
import { lru } from '#fixture-cache'
import { local } from '../utils/local'

export default (): unknown[] => [options, app, root, useNuxtApp, helper(), lru, local]
`,
      'src/runtime/utils/local.ts': `export const local: string = 'local'\n`,
      'src/runtime/utils/options.ts': `import type { DeepPartial } from 'fake-types'
import { helper } from 'fake-dep'

export type Options = DeepPartial<{ a: { b: string } }>
export const defineOptions = (options: Options) => ({ options, helper })
`,
    })
    const transpileNuxtTsconfig = join(transpileRootDir, '.nuxt/tsconfig.json')
    const transpileNuxtConfig = JSON.parse(await readFile(transpileNuxtTsconfig, 'utf-8'))
    transpileNuxtConfig.compilerOptions.paths['#fixture-cache'] = ['../src/runtime/cache/lru']
    await writeFile(transpileNuxtTsconfig, JSON.stringify(transpileNuxtConfig))

    await copyExample(solutionRootDir, contents => contents)
    await writeFiles(solutionRootDir, {
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.server.json' }] }),
      'tsconfig.app.json': JSON.stringify({ extends: './.nuxt/tsconfig.json', include: ['.nuxt/nuxt.d.ts', 'src/**/*'], exclude: ['src/runtime/server/**'] }),
      'tsconfig.server.json': JSON.stringify({ extends: './.nuxt/tsconfig.json', compilerOptions: { paths: { '#server-only': ['./src/runtime/server/only.ts'] } }, include: ['src/runtime/server/**/*'] }),
      'src/runtime/server/only.ts': `export interface ServerOnly { id: string }\n`,
      'src/runtime/server/api/[id].get.ts': `import type { ServerOnly } from '#server-only'\n\nexport default (value: ServerOnly) => value.id\n`,
    })

    await copyExample(parentTsconfigRootDir, contents => contents)
    await mkdir(join(parentTsconfigRootDir, 'packages/mod'), { recursive: true })
    for (const file of ['src', 'package.json']) {
      await cp(join(parentTsconfigRootDir, file), join(parentTsconfigRootDir, 'packages/mod', file), { recursive: true })
      await rm(join(parentTsconfigRootDir, file), { recursive: true, force: true })
    }
    const loggerStore = 'node_modules/.pnpm/fake-logger@1.0.0/node_modules/fake-logger'
    await writeFiles(parentTsconfigRootDir, {
      [`${loggerStore}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.mts', default: './dist/index.mjs' }, './utils': { types: './dist/utils.d.mts', default: './dist/utils.mjs' } } }),
      [`${loggerStore}/dist/utils.d.mts`]: `export declare const noop: () => void\n`,
      [`${loggerStore}/dist/utils.mjs`]: `export const noop = () => {}\n`,
      [`${loggerStore}/dist/core.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\n`,
      [`${loggerStore}/dist/core.d.mts`]: `export interface LoggerInstance { log: (message: string) => void }\n`,
      [`${loggerStore}/dist/index.d.ts`]: `import type { LoggerInstance } from './core'\nexport type { LoggerInstance }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${loggerStore}/dist/index.d.mts`]: `import type { LoggerInstance } from './core.mjs'\nexport type { LoggerInstance }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${loggerStore}/dist/index.mjs`]: `export const createLogger = () => ({ log: console.log })\n`,
      'packages/mod/src/runtime/logger.ts': `import { createLogger } from 'fake-logger'\nimport { noop } from 'fake-logger/utils'\n\nexport const logger = createLogger()\nexport const silence = noop\n`,
    })
    await mkdir(join(parentTsconfigRootDir, 'packages/mod/node_modules'), { recursive: true })
    await symlink(join(parentTsconfigRootDir, loggerStore), join(parentTsconfigRootDir, 'packages/mod/node_modules/fake-logger'))
    const parentNuxtTsconfig = join(parentTsconfigRootDir, '.nuxt/tsconfig.json')
    const parentNuxtConfig = JSON.parse(await readFile(parentNuxtTsconfig, 'utf-8'))
    parentNuxtConfig.compilerOptions.paths['fake-logger'] = [`../${loggerStore}`]
    await writeFile(parentNuxtTsconfig, JSON.stringify(parentNuxtConfig))

    await copyExample(portableRootDir, contents => `import { defineThing } from 'fake-kit'\n${contents}\nexport const thing = defineThing({ name: 'portable' })\n`)
    const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`
    await writeFiles(portableRootDir, {
      [`${store('fake-schema')}/package.json`]: JSON.stringify({ name: 'fake-schema', types: './index.d.ts' }),
      [`${store('fake-schema')}/index.d.ts`]: `export interface Thing<T> { options: T }\n`,
      [`${store('fake-kit')}/package.json`]: JSON.stringify({ name: 'fake-kit', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-kit')}/index.d.ts`]: `import type { Thing } from 'fake-schema'\nexport declare function defineThing<T>(options: T): Thing<T>\n`,
      [`${store('fake-kit')}/index.js`]: `export const defineThing = options => ({ options })\n`,
    })
    await symlink(join(portableRootDir, store('fake-schema')), join(portableRootDir, 'node_modules/.pnpm/fake-kit@1.0.0/node_modules/fake-schema'))
    await symlink(join(portableRootDir, store('fake-schema')), join(portableRootDir, 'node_modules/fake-schema'))
    await symlink(join(portableRootDir, store('fake-kit')), join(portableRootDir, 'node_modules/fake-kit'))
    const portableNuxtTsconfig = join(portableRootDir, '.nuxt/tsconfig.json')
    const portableNuxtConfig = JSON.parse(await readFile(portableNuxtTsconfig, 'utf-8'))
    portableNuxtConfig.compilerOptions.paths['fake-schema'] = [`../${store('fake-schema')}`]
    await writeFile(portableNuxtTsconfig, JSON.stringify(portableNuxtConfig))
    const portableNuxtTypes = join(portableRootDir, '.nuxt/nuxt.d.ts')
    await writeFile(portableNuxtTypes, `/// <reference types="fake-schema" />\n${await readFile(portableNuxtTypes, 'utf-8')}`)

    await copyExample(stylesheetsRootDir, contents => contents)
    await writeFiles(join(stylesheetsRootDir, 'src/runtime'), {
      'styles/card.css': `@import "./base.css";\n\n.card {\n  user-select: none;\n  & .title { font-weight: bold; }\n  &:hover { color: rebeccapurple; }\n}\n`,
      'styles/base.css': `.base { margin: 0px 0px; }\n`,
      'styles/_variables.scss': `$primary: #00dc82;\n`,
      'styles/theme.scss': `@use "variables" as v;\n.theme { color: v.$primary; .nested { padding: 1px; } }\n`,
      'styles/indented.sass': `.indented\n  color: blue\n`,
      'styles/legacy.less': `@c: red;\n.less { color: @c; }\n`,
      'types/ambient.d.ts': `declare global { interface Window { __fixture: true } }\nexport {}\n`,
      'types/app.d.ts': `import type { NuxtApp } from '#app'\nexport type App = NuxtApp\n`,
      'plugins/styled.ts': `import '../styles/card.css'\nimport '../styles/theme.scss'\n\nexport const styled = true\n`,
    })

    await copyExample(runtimeShapeRootDir, contents => contents)
    const runtimeShapePkg = JSON.parse(await readFile(join(runtimeShapeRootDir, 'package.json'), 'utf-8'))
    await writeFile(join(runtimeShapeRootDir, 'package.json'), JSON.stringify({ ...runtimeShapePkg, build: { entries: ['./src/utils', './src/utils/merge.ts'] } }, null, 2))
    await writeFile(join(runtimeShapeRootDir, '.nuxt/app.config.ts'), `export default { theme: { buildMachineOnly: 'must-not-be-published' as const } }\n`)
    await writeFile(join(runtimeShapeRootDir, 'external.ts'), `export const answer = 42\n`)
    for (const name of ['fake-polyfill', 'fake-register']) {
      await writeFiles(join(runtimeShapeRootDir, 'node_modules', name), {
        'package.json': JSON.stringify({ name, type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
        'index.js': `globalThis.__order = [...globalThis.__order ?? [], '${name}']\n`,
        'index.d.ts': `export {}\n`,
      })
    }
    await writeFiles(join(runtimeShapeRootDir, 'src'), {
      'utils/merge.ts': `export const merge = <T extends object>(a: T, b: T): T => ({ ...a, ...b })\n`,
      'shared/constants.ts': `import { LIMIT } from './limits'\n\nexport const CONSTANT = LIMIT\n`,
      'shared/limits.ts': `export const LIMIT = 10\n`,
      'types.ts': `export interface RootType { root: string }\n`,
      'types/middlewares.ts': `export type RequestSizeLimiter = { maxRequestSizeInBytes: number }\n`,
      'runtime/server/limiter.ts': `import { type RequestSizeLimiter } from '../../types/middlewares'\nimport {} from 'nuxt/app'\nimport '../disabled/side'\n\nexport const limit = (options: RequestSizeLimiter) => options.maxRequestSizeInBytes\n`,
      'routing.ts': `import { readFileSync } from 'node:fs'\nimport { generate } from './kit/gen'\nimport type { RootType } from './types'\n\nexport interface RouteInfo { path: string, root: RootType }\nexport const localizeRoutes = (file: string): string => generate(readFileSync(file, 'utf8'))\n`,
      'kit/gen.ts': `import { createHash } from 'node:crypto'\n\nexport const generate = (input: string) => createHash('sha1').update(input).digest('hex')\n`,
      'runtime/composables/useLocaleRoute.ts': `import { RouteInfo } from '../../routing'\n\nexport const useLocaleRoute = (route: RouteInfo) => route\n`,
      'runtime/types.ts': `export interface RuntimeType { runtime: string }\n`,
      'runtime/server/uses.ts': [
        `import { merge } from '../../utils/merge'`,
        `import { CONSTANT } from '../../shared/constants'`,
        `import type { RootType } from '../../types'`,
        `import type { RuntimeType } from '../types'`,
        ``,
        `export const combine = (a: RootType & RuntimeType, b: RootType & RuntimeType) => [merge(a, b), CONSTANT] as const`,
        ``,
      ].join('\n'),
      'runtime/escaping.ts': `export const load = () => import('../../external')\n`,
      'runtime/composables/mock.ts': `export const defineThing = () => 'mock'\n`,
      'runtime/disabled/composables/defineThing.ts': `export { defineThing } from '../../composables/mock'\n`,
      'runtime/disabled/index.ts': `import './side'\nexport { defineThing } from './composables/defineThing'\n`,
      'runtime/disabled/side.ts': `globalThis.__side = true\n`,
      'runtime/order/first.ts': `import 'fake-polyfill'\nimport 'vue'\nimport './order.css'\nimport './effect'\nimport 'fake-register'\nexport { level } from './levels'\n`,
      'runtime/order/interleaved.ts': [
        `import 'fake-register'`,
        `import { level } from './levels'`,
        `export * from './reexported'`,
        `import './order.css'`,
        `export { useState } from '#imports'`,
        `import 'fake-polyfill'`,
        `import './effect'`,
        `import { ref } from 'vue'`,
        ``,
        `export const value = ref(level)`,
        ``,
      ].join('\n'),
      'runtime/order/levels.ts': `export const level = 1\n`,
      'runtime/order/reexported.ts': `export const reexported = 1\n`,
      'runtime/order/effect.ts': `globalThis.__effect = true\n`,
      'runtime/order/order.css': `.order { color: red }\n`,
      'runtime/content/index.ts': `export * from '../components/TestMe.vue'\nexport * from '../components/TestMeSetup.vue'\nexport * from './prose'\n`,
      'runtime/content/prose.ts': `export * from './levels'\nexport interface ProseThing { title: string }\n`,
      'runtime/content/levels.ts': `export const proseLevel = 1\n`,
      'runtime/utils/provider.ts': `import type { ModuleOptions } from '../../module'\n\nexport const defineProvider = (options: ModuleOptions) => options\n`,
      'runtime/utils/props.ts': `export interface BaseProps { size?: number }\n`,
      'runtime/composables/useThemeConfig.ts': `import appConfig from '#build/app.config'\n\nexport const useThemeConfig = () => appConfig.theme\n`,
      'runtime/composables/useButton.ts': `import theme, { variants } from '#build/ui/button'\nimport * as config from '#build/app.config'\n\nexport const useButton = () => ({ slots: theme.slots, size: variants.size, ui: config.default.ui })\n`,
      'runtime/components/Button.vue': `<script setup lang="ts">\nimport theme, { variants } from '#build/ui/button'\nimport * as config from '#build/app.config'\n\nconst props = defineProps<{ size?: string }>()\nconst classes = [theme.base, variants[props.size ?? 'md'], config.default.ui]\ndefineExpose({ classes })\n</script>\n\n<template>\n  <button :class="classes" />\n</template>\n`,
      'runtime/components/Sized.vue': `<script setup lang="ts">\nimport type { BaseProps } from '../utils/props'\nimport { useThemeConfig } from '../composables/useThemeConfig'\n\ndefineProps<BaseProps>()\nconst theme = useThemeConfig()\n</script>\n\n<template>\n  <div>{{ theme }}</div>\n</template>\n`,
    })

    await copyExample(routesRootDir, contents => contents
      .replace('import { defineNuxtModule, addPlugin, createResolver }', 'import { defineNuxtModule, addPlugin, addServerHandler, createResolver }')
      .replace(`addPlugin(resolver.resolve('./runtime/plugins/plugin'))`, `addPlugin(resolver.resolve('./runtime/plugins/plugin'))\n    addServerHandler({ route: '/api/own', handler: resolver.resolve('./runtime/server/api/own') })`))
    await writeFiles(routesRootDir, {
      '.nuxtrc': `${(await readFile(join(rootDir, '.nuxtrc'), 'utf-8')).trimEnd()}\nworkspaceDir=..\n`,
      '../tsconfig.json': JSON.stringify({ extends: './mod/playground/.nuxt/tsconfig.json', compilerOptions: { types: ['fake-global-types'] }, exclude: ['**/dist', '**/node_modules'] }),
      'node_modules/fake-global-types/package.json': JSON.stringify({ name: 'fake-global-types', types: 'index.d.ts' }),
      'node_modules/fake-global-types/index.d.ts': `declare namespace Fake {\n  interface Thing { id: number }\n  function current(): Thing\n}\n`,
      'src/runtime/composables/useGlobal.ts': `export const useGlobal = () => Fake.current()\n`,
      'src/runtime/server/api/own.ts': `export default () => ({ own: 'module-owned' as const })\n`,
      'src/runtime/composables/useOwn.ts': `import { useFetch } from '#app'\n\nexport const useOwn = () => useFetch('/api/own')\n`,
      'src/runtime/composables/useSecret.ts': `import { useFetch } from '#app'\n\nexport const useSecret = () => useFetch('/api/secret')\n`,
      'src/runtime/composables/useSibling.ts': `import { useFetch } from '#app'\n\nexport const useSibling = () => useFetch('/api/sibling')\n`,
      'src/runtime/composables/useDocs.ts': `import { useFetch } from '#app'\n\nexport const useDocs = () => useFetch('/api/docs')\n`,
      'src/runtime/components/Routes.vue': `<script setup lang="ts">\nimport { useFetch } from '#app'\n\nconst own = await useFetch('/api/own')\nconst secret = await useFetch('/api/secret')\ndefineExpose({ own: own.data, secret: secret.data })\n</script>\n\n<template>\n  <div />\n</template>\n`,
      'playground/server/api/secret.ts': `export default () => ({ localRoute: 'must-not-be-published' as const })\n`,
      'playground/types/routes.d.ts': `declare module 'nitropack/types' {\n  interface InternalApi {\n    '/api/secret': { default: 'must-not-be-published' }\n  }\n}\n`,
      'docs/types/routes.d.ts': `declare module 'nitropack/types' {\n  interface InternalApi {\n    '/api/docs': { default: 'must-not-be-published' }\n  }\n}\n`,
      '../sibling/types/routes.d.ts': `declare module 'nitropack/types' {\n  interface InternalApi {\n    '/api/sibling': { default: 'must-not-be-published' }\n  }\n}\n`,
    })
    await rm(join(routesRootDir, 'tsconfig.json'))
    await rm(join(routesRootDir, 'playground/node_modules/my-module'), { force: true })
    await symlink(routesRootDir, join(routesRootDir, 'playground/node_modules/my-module'))
    const nuxtEnv = { ...process.env, NUXT_TELEMETRY_DISABLED: '1' }

    await Promise.all([
      exec('pnpm', ['nuxt-module-build', 'build', '--stub', routesRootDir], { nodeOptions: { cwd: repoRoot }, throwOnError: true })
        .then(() => exec('pnpm', ['nuxt-module-build', 'prepare', routesRootDir], { nodeOptions: { cwd: repoRoot, env: nuxtEnv }, throwOnError: true }))
        .then(() => exec('pnpm', ['exec', 'nuxt', 'prepare', join(routesRootDir, 'playground')], { nodeOptions: { cwd: repoRoot, env: nuxtEnv }, throwOnError: true }))
        .then(() => exec('pnpm', ['nuxt-module-build', 'build', routesRootDir], { nodeOptions: { cwd: repoRoot, env: { ...process.env, NODE_ENV: '', TEST: '' } }, throwOnError: true }))
        .then(({ stdout, stderr }) => { routesBuild = stdout + stderr }),
      exec('pnpm', ['prepack'], { nodeOptions: { cwd: stylesheetsRootDir } }),
      exec('pnpm', ['nuxt-module-build', 'build', runtimeShapeRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['dev:prepare'], { nodeOptions: { cwd: rootDir } }).then(() => exec('pnpm', ['prepack'], { nodeOptions: { cwd: rootDir } })),
      exec('pnpm', ['dev:prepare'], { nodeOptions: { cwd: secondRootDir } }).then(() => exec('pnpm', ['prepack'], { nodeOptions: { cwd: secondRootDir } })),
      exec('pnpm', ['dev:prepare'], { nodeOptions: { cwd: encodedRootDir } }).then(() => exec('pnpm', ['prepack'], { nodeOptions: { cwd: encodedRootDir } })),
      exec('pnpm', ['prepack'], { nodeOptions: { cwd: thirdRootDir } }),
      exec('pnpm', ['prepack'], { nodeOptions: { cwd: fourthRootDir } }),
      exec('pnpm', ['prepack'], { nodeOptions: { cwd: noRuntimeRootDir } }),
      exec('pnpm', ['nuxt-module-build', 'build', '--stub', unpreparedRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', '--stub', jsSpecifierRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', annotatedRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['prepack'], { nodeOptions: { cwd: vueOnlyRootDir } }),
      exec('pnpm', ['nuxt-module-build', 'build', '--stub', wildcardRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', buildConfigRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', replaceRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', transpileRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', solutionRootDir], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', join(parentTsconfigRootDir, 'packages/mod')], { nodeOptions: { cwd: repoRoot } }),
      exec('pnpm', ['nuxt-module-build', 'build', portableRootDir], { nodeOptions: { cwd: repoRoot } }),
    ])
  }, 180 * 1000)

  it('should build `build.config.ts` entries under the names unbuild gave them', async () => {
    const files = await readdir(join(buildConfigRootDir, 'dist'), { recursive: true })
    expect(files.filter(file => !file.startsWith('runtime')).sort()).toMatchInlineSnapshot(`
      [
        "content.d.mts",
        "content.mjs",
        "features",
        "features/flag.d.ts",
        "features/flag.js",
        "module.d.mts",
        "module.json",
        "module.mjs",
        "nested",
        "nested/helper.d.mts",
        "nested/helper.mjs",
        "shared",
        "shared/format.d.mts",
        "shared/format.mjs",
        "types.d.mts",
        "utils.d.mts",
        "utils.mjs",
        "vite.d.mts",
        "vite.mjs",
      ]
    `)
  })

  it('should import runtime code relative to nested entries', async () => {
    const helper = await readFile(join(buildConfigRootDir, 'dist/nested/helper.mjs'), 'utf-8')
    expect(findStaticImports(helper).map(i => i.specifier)).toEqual(['../runtime/plugins/plugin.js'])
    expect(helper).toContain('import("../runtime/composables/useWrappedFetch.js")')
    expect(helper).not.toContain(buildConfigRootDir)
  })

  it('should run `build.config.ts` hooks in order with the build context', async () => {
    const log = (await readFile(join(buildConfigRootDir, 'hooks.log'), 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(log.slice(0, 3)).toEqual([
      expect.objectContaining({ hook: 'build:before', stub: false }),
      expect.objectContaining({ hook: 'rollup:done', stub: false, meta: true }),
      expect.objectContaining({ hook: 'build:done', stub: false, meta: true }),
    ])
    expect(log[0].entries).toEqual(['content', 'features', 'module', 'nested/helper', 'runtime', 'shared', 'utils', 'vite'])
    expect(await readFile(join(buildConfigRootDir, 'dist/vite.mjs'), 'utf-8')).toContain('from build:before')
  })

  it('should read the `unbuild` field of `package.json` in preference to `build`', async () => {
    const unplugin = await readFile(join(replaceRootDir, 'dist/unplugin.mjs'), 'utf-8')
    expect(unplugin).toContain('from "ext-pkg"')
    expect(unplugin).not.toContain('bundled-ext-pkg')
    expect(existsSync(join(replaceRootDir, 'dist/utils.mjs'))).toBe(false)
  })

  it('should keep `build.config.ts` externals external', async () => {
    const vite = await readFile(join(buildConfigRootDir, 'dist/vite.mjs'), 'utf-8')
    expect(vite).toContain('from "fake-pkg/sub"')
    expect(vite).toContain('from "regex-pkg"')
    const content = await readFile(join(buildConfigRootDir, 'dist/content.mjs'), 'utf-8')
    expect(content).toContain('from "#content-alias/config"')
    expect(vite + content).not.toContain('bundled-')
  })

  it('should apply `build.config.ts` replacements', async () => {
    const vite = await readFile(join(buildConfigRootDir, 'dist/vite.mjs'), 'utf-8')
    expect(vite).toContain('"1.2.3"')
    expect(vite).not.toContain('__MODULE_VERSION__')

    const unplugin = await readFile(join(replaceRootDir, 'dist/unplugin.mjs'), 'utf-8')
    expect(unplugin).not.toContain('--uiDev')
    expect(unplugin).toMatch(/isDev = false/)
  })

  it('should stub a module whose source needs more than type stripping', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', '--stub', stubSyntaxRootDir], { nodeOptions: { cwd: repoRoot, env: { ...process.env, CI: '' } } })
    expect(exitCode).toBe(0)
    expect(JSON.parse(await readFile(join(stubSyntaxRootDir, 'dist/module.json'), 'utf-8')).name).toBe('my-module-stub-high')
    expect((stdout + stderr).match(/erasableSyntaxOnly/g)).toHaveLength(1)
    expect(stdout + stderr).toContain(guide('stub-builds'))
    expect(stdout + stderr).not.toContain('do not exist after the build')
  }, 60 * 1000)

  it('should warn that `build.config.ts` is deprecated and stub its entries', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', '--stub', '--outDir', '.stub', buildConfigRootDir], { nodeOptions: { cwd: repoRoot, env: { ...process.env, CI: '' } } })
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toMatch(new RegExp(`\`build\\.config\\.ts\` is deprecated\\..*${guide('build-configuration')}`))
    expect(stdout + stderr).not.toContain('instead of')
    expect(stdout + stderr).not.toContain('`unbuild` field')
    const files = await readdir(join(buildConfigRootDir, '.stub'), { recursive: true })
    expect(files).toEqual(expect.arrayContaining(['content.mjs', 'nested/helper.mjs', 'utils.mjs', 'vite.mjs']))
    const log = (await readFile(join(buildConfigRootDir, 'hooks.log'), 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(log.filter(entry => entry.stub).map(entry => entry.hook)).toEqual(['build:before', 'rollup:done', 'build:done'])
  }, 60 * 1000)

  it('should fail on every `build.config.ts` option without an equivalent', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', unsupportedRootDir], { nodeOptions: { cwd: repoRoot } })
    expect(exitCode).not.toBe(0)
    for (const option of ['entries[0].ext', 'entries[1].builder: \'untyped\'', 'hooks[\'build:prepare\']', 'hooks[\'rollup:options\']', 'rollup.emitCJS: true', 'rollup.alias', 'stub', 'unknownOption']) {
      expect(stdout + stderr).toContain(`build.config.ts: ${option}`)
    }
    expect(stdout + stderr).not.toContain('build.config.ts: hooks[\'mkdist:entry:options\']')
    expect(stdout + stderr).toContain(`build.config.ts: rollup.emitCJS: true (${guide('commonjs-output')})`)
    expect(stdout + stderr).toContain(guide('unsupported-build-options'))
  }, 60 * 1000)

  it('should surface isolated declaration diagnostics when the tsconfig opts in', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', isolatedRootDir], { nodeOptions: { cwd: repoRoot } })
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/Declaration generation failed under `?isolatedDeclarations/)
    expect(stdout + stderr).toMatch(/TS90\d\d/)
    expect(stdout + stderr).toContain(guide('isolated-declarations'))
    expect(stdout + stderr).not.toMatch(/Type declarations could not be generated/)
  }, 60 * 1000)

  it('should explain type errors that prevent declaration generation', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', typeErrorRootDir], { nodeOptions: { cwd: repoRoot } })
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/TS4094/)
    expect(stdout + stderr).toMatch(/Type declarations could not be generated/)
    expect(stdout + stderr).toMatch(/cannot reference by name.*explicit type annotation, such as `ReturnType<typeof fn>` for a value produced by an imported `fn`:\n- `defineCachedHandler` in \S*src\/runtime\/server\/cached\.ts:3\n/)
    expect(stdout + stderr).toContain(guide('portability-errors'))
    expect(existsSync(join(typeErrorRootDir, 'dist'))).toBe(false)
  }, 60 * 1000)

  it('should fail on portability errors in a single-file component and in a script sharing its program', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', vueErrorRootDir], { nodeOptions: { cwd: repoRoot } })
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/components\/Cached\.vue\(4,14\): error TS2742/)
    expect(stdout + stderr).toMatch(/server\/cached\.ts\(3,14\): error TS2742/)
    expect(stdout + stderr).toMatch(/cannot reference by name.*:\n(?:- `\w+` in \S+\n)*- `cachedHandler` in \S*src\/runtime\/components\/Cached\.vue:4\n/)
    expect(stdout + stderr).toMatch(/\n- `defineCachedHandler` in \S*src\/runtime\/server\/cached\.ts:3\n/)
    expect(stdout + stderr).toContain(guide('portability-errors'))
    expect(existsSync(join(vueErrorRootDir, 'dist'))).toBe(false)
  }, 60 * 1000)

  it('should warn about type errors that do not affect runtime declarations and build anyway', async () => {
    const { stdout, stderr, exitCode } = await exec('pnpm', ['nuxt-module-build', 'build', semanticErrorRootDir], { nodeOptions: { cwd: repoRoot } })
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toMatch(/2 type errors were reported while generating declarations for `?src\/runtime`?; the declarations were emitted\. If the module's own type check \(for example `?nuxt typecheck`? or `?vue-tsc --noEmit`?\) passes/)
    expect(stdout + stderr).toContain('src/runtime/utils/typo.ts(1,14): error TS2322')
    expect(stdout + stderr).toContain('src/runtime/components/Typo.vue(3,7): error TS2322')
    expect((stdout + stderr).match(/type errors? (?:was|were) reported/g)).toHaveLength(1)
    expect(stdout + stderr).toContain(guide('other-type-errors'))
    expect(await readFile(join(semanticErrorRootDir, 'dist/runtime/utils/typo.d.ts'), 'utf-8')).toBe('export declare const count: number;\nexport declare const double: (value: number) => number;\n')
    const component = await readFile(join(semanticErrorRootDir, 'dist/runtime/components/Typo.vue.d.ts'), 'utf-8')
    expect(component).toContain('label: string')
    expect(component).toBe(await readFile(join(semanticErrorRootDir, 'dist/runtime/components/Typo.d.vue.ts'), 'utf-8'))
    expect(stdout + stderr).not.toContain('TS2307')
    const composable = await readFile(join(semanticErrorRootDir, 'dist/runtime/composables/useSize.d.ts'), 'utf-8')
    expect(composable).toContain(`import type { Props } from '../components/Sized.vue';`)
    expect(composable).toMatch(/export declare function useSize\(props: Props\): import\("vue"\)\.ComputedRef<"xs" \| "sm" \| "md" \| undefined>;/)
  }, 60 * 1000)

  it('should build an annotated module under `isolatedDeclarations` while still inferring runtime types', async () => {
    const annotatedDistDir = join(annotatedRootDir, 'dist')
    const moduleTypes = await readFile(join(annotatedDistDir, 'module.d.mts'), 'utf-8')
    expect(moduleTypes).toContain('NuxtModule<ModuleOptions>')
    expect(moduleTypes).toMatch(/apiKey: string/)
    const pluginTypes = await readFile(join(annotatedDistDir, 'runtime/plugins/plugin.d.ts'), 'utf-8')
    expect(pluginTypes).toContain('import("nuxt/app").Plugin<')
    expect(JSON.parse(await readFile(join(annotatedDistDir, 'module.json'), 'utf-8'))).toMatchObject({ name: 'my-module', configKey: 'myModule' })
  })

  it('should not let a wildcard `paths` entry shadow real packages when loading meta', async () => {
    const meta = JSON.parse(await readFile(join(wildcardRootDir, 'dist/module.json'), 'utf-8'))
    expect(meta).toMatchObject({ name: 'wildcard-module', configKey: 'wildcardModule' })
  })

  it('should mirror the runtime source tree even when it has a single subdirectory', async () => {
    const files = await readdir(join(fourthDistDir, 'runtime'), { recursive: true, withFileTypes: true })
    const names = files.filter(file => file.isFile()).map(file => join(file.parentPath, file.name).replace(join(fourthDistDir, 'runtime') + '/', ''))
    expect(names.sort()).toMatchInlineSnapshot(`
      [
        "plugins/plugin.d.ts",
        "plugins/plugin.js",
      ]
    `)
  })

  it('should stub a module before `.nuxt` has been generated', async () => {
    const meta = JSON.parse(await readFile(join(unpreparedRootDir, 'dist/module.json'), 'utf-8'))
    expect(meta).toMatchObject({ name: 'my-module', configKey: 'myModule' })
    expect(existsSync(join(unpreparedRootDir, '.nuxt'))).toBe(false)
  })

  it('should stub a module that imports TypeScript sources through `.js` specifiers', async () => {
    const meta = JSON.parse(await readFile(join(jsSpecifierRootDir, 'dist/module.json'), 'utf-8'))
    expect(meta).toMatchObject({ name: 'my-module', configKey: 'myModule' })
  })

  it('should reference `@nuxt/schema` rather than `nuxt/schema` in module declarations', async () => {
    const types = await readFile(join(distDir, 'module.d.mts'), 'utf-8')
    expect(types).toContain('import("@nuxt/schema")')
    expect(types).not.toContain('import("nuxt/schema")')
  })

  it('should build a module without a runtime directory', async () => {
    const files = await readdir(join(noRuntimeRootDir, 'dist'))
    expect(files.sort()).toEqual(['module.d.mts', 'module.json', 'module.mjs', 'types.d.mts', 'utils.d.mts', 'utils.mjs'])
  })

  it('should build a runtime directory that contains only single-file components', async () => {
    const files = await readdir(join(vueOnlyRootDir, 'dist/runtime'), { recursive: true })
    expect(files.sort()).toMatchInlineSnapshot(`
      [
        "components",
        "components/TestMe.css",
        "components/TestMe.d.vue.ts",
        "components/TestMe.vue",
        "components/TestMe.vue.d.ts",
        "components/TestMeSetup.d.vue.ts",
        "components/TestMeSetup.vue",
        "components/TestMeSetup.vue.d.ts",
      ]
    `)
  })

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

  it('should copy non-code files in the runtime directory', async () => {
    expect(await readdir(join(runtimeDir, 'assets'))).toMatchInlineSnapshot(`
      [
        "config.json",
      ]
    `)
    expect(await readFile(join(runtimeDir, 'components/TestMe.css'), 'utf-8')).toBe('.test-me{color:#639}')
  })

  it('should flatten, prefix and minify runtime CSS', async () => {
    const card = await readFile(join(stylesheetsRootDir, 'dist/runtime/styles/card.css'), 'utf-8')
    expect(card).toMatch(/^@import "\.\/base\.css";/)
    expect(card).toContain('.card .title{font-weight:700}')
    expect(card).toContain('.card:hover{color:#639}')
    expect(card).toContain('-webkit-user-select:none')
    expect(card).not.toMatch(/&|\n/)
  })

  it('should compile runtime Sass to CSS and skip partials', async () => {
    const styles = join(stylesheetsRootDir, 'dist/runtime/styles')
    expect((await readdir(styles)).sort()).toEqual(['base.css', 'card.css', 'indented.css', 'legacy.less', 'theme.css'])
    expect(await readFile(join(styles, 'theme.css'), 'utf-8')).toMatch(/^\.theme \.nested \{\s*padding: 1px;\s*\}$/m)
    expect(await readFile(join(styles, 'theme.css'), 'utf-8')).toContain('color: #00dc82;')
    expect(await readFile(join(styles, 'indented.css'), 'utf-8')).toContain('color: blue;')
  })

  it('should copy runtime declaration files verbatim', async () => {
    const file = 'types/ambient.d.ts'
    expect(await readFile(join(stylesheetsRootDir, 'dist/runtime', file), 'utf-8')).toBe(await readFile(join(stylesheetsRootDir, 'src/runtime', file), 'utf-8'))
  })

  it('should rewrite `#app` in copied runtime declaration files', async () => {
    expect(await readFile(join(stylesheetsRootDir, 'dist/runtime/types/app.d.ts'), 'utf-8')).toBe(`import type { NuxtApp } from 'nuxt/app'\nexport type App = NuxtApp\n`)
  })

  it('should keep stylesheet imports in runtime scripts as written', async () => {
    const styled = await readFile(join(stylesheetsRootDir, 'dist/runtime/plugins/styled.js'), 'utf-8')
    expect(styled).toContain('import "../styles/card.css";')
    expect(styled).toContain('import "../styles/theme.scss";')
  })

  it('should keep every non-relative runtime import as written', async () => {
    const handler = await readFile(join(transpileRootDir, 'dist/runtime/server/handler.js'), 'utf-8')
    expect(findStaticImports(handler).map(i => i.specifier)).toEqual([
      '#internal/nuxt.config.mjs',
      '~/app.config',
      '@/root',
      '#app',
      'fake-dep',
      '#fixture-cache',
      '../utils/local.js',
    ])
    const options = await readFile(join(transpileRootDir, 'dist/runtime/utils/options.d.ts'), 'utf-8')
    expect(findStaticImports(options).map(i => i.specifier)).toEqual(['fake-types'])
  })

  it('should not emit dependencies or bundler helpers into the runtime directory', async () => {
    const files = await readdir(join(transpileRootDir, 'dist/runtime'), { recursive: true })
    expect(files.filter(file => /node_modules|_virtual/.test(file))).toEqual([])
    for (const file of files.filter(file => /\.m?[jt]s$/.test(file))) {
      expect(await readFile(join(transpileRootDir, 'dist/runtime', file), 'utf-8'), file).not.toMatch(/bundled-fake-dep|DeepPartial<T\[K\]>/)
    }
  })

  it('should keep types of packages that are not dependencies external in module declarations', async () => {
    const types = await readFile(join(transpileRootDir, 'dist/module.d.mts'), 'utf-8')
    expect(types).toMatch(/from "fake-types"/)
    expect(types).toMatch(/from "fake-cjs-types"/)
    expect(types).not.toMatch(/DeepPartial<T\[K\]>/)
  })

  it('should keep bracketed file names in runtime output', async () => {
    expect(existsSync(join(transpileRootDir, 'dist/runtime/server/routes/[...slug].js'))).toBe(true)
    expect(existsSync(join(transpileRootDir, 'dist/runtime/server/routes/[...slug].d.ts'))).toBe(true)
  })

  it('should resolve imports of the package itself to its source in declarations', async () => {
    const types = await readFile(join(transpileRootDir, 'dist/runtime/utils/self.d.ts'), 'utf-8')
    expect(types).toMatch(/=> string;/)
  })

  it('should generate declarations for each project of a solution-style tsconfig', async () => {
    const route = await readFile(join(solutionRootDir, 'dist/runtime/server/api/[id].get.d.ts'), 'utf-8')
    expect(route).toMatch(/=> string;/)
    const app = await readFile(join(solutionRootDir, 'dist/runtime/composables/useAliasedApp.d.ts'), 'utf-8')
    expect(app).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
    expect(existsSync(join(solutionRootDir, 'dist/runtime/components/TestMe.vue.d.ts'))).toBe(true)
  })

  it('should use a tsconfig from a parent directory', async () => {
    const app = await readFile(join(parentTsconfigRootDir, 'packages/mod/dist/runtime/composables/useAliasedApp.d.ts'), 'utf-8')
    expect(app).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
  })

  it('should name runtime types by package when the generated tsconfig maps the package into the store', async () => {
    const logger = await readFile(join(parentTsconfigRootDir, 'packages/mod/dist/runtime/logger.d.ts'), 'utf-8')
    expect(logger).toMatch(/import\("fake-logger"\)\.LoggerInstance/)
  })

  it('should keep the imports and re-exports of each runtime file as written', async () => {
    const dist = join(runtimeShapeRootDir, 'dist/runtime')
    const read = (file: string) => readFile(join(dist, file), 'utf-8')
    expect(await read('disabled/index.js')).toMatchInlineSnapshot(`
      "import "./side.js";
      export { defineThing } from "./composables/defineThing.js";
      "
    `)
    expect(await read('disabled/composables/defineThing.js')).toMatchInlineSnapshot(`
      "export { defineThing } from "../../composables/mock.js";
      "
    `)
    expect(await read('content/index.js')).toMatchInlineSnapshot(`
      "export * from "../components/TestMe.vue";
      export * from "../components/TestMeSetup.vue";
      export * from "./prose.js";
      "
    `)
    expect(await read('content/index.d.ts')).toMatchInlineSnapshot(`
      "export * from '../components/TestMe.vue';
      export * from '../components/TestMeSetup.vue';
      export * from './prose.js';
      "
    `)
    expect(await read('content/prose.js')).toMatchInlineSnapshot(`
      "export * from "./levels.js";
      "
    `)
    expect(await read('content/prose.d.ts')).toMatchInlineSnapshot(`
      "export * from './levels.js';
      export interface ProseThing {
          title: string;
      }
      "
    `)
  })

  it('should keep the source order of imports and re-exports in each runtime file', async () => {
    const dist = join(runtimeShapeRootDir, 'dist/runtime/order')
    expect(await readFile(join(dist, 'interleaved.js'), 'utf-8')).toMatchInlineSnapshot(`
      "import "fake-register";
      import { level } from "./levels.js";
      export * from "./reexported.js";
      import "./order.css";
      export { useState } from "#imports";
      import "fake-polyfill";
      import "./effect.js";
      import { ref } from "vue";
      export const value = ref(level);
      "
    `)
  })

  it('should point runtime imports outside the runtime directory at the files emitted for them', async () => {
    const dist = join(runtimeShapeRootDir, 'dist')
    expect(await readFile(join(dist, 'runtime/server/uses.js'), 'utf-8')).toMatchInlineSnapshot(`
      "import { merge } from "../../utils/merge.mjs";
      import { CONSTANT } from "../../shared/constants.js";
      export const combine = (a, b) => [merge(a, b), CONSTANT];
      "
    `)
    expect(await readFile(join(dist, 'runtime/server/uses.d.ts'), 'utf-8')).toMatchInlineSnapshot(`
      "import type { RootType } from '../../_external/src/types.js';
      import type { RuntimeType } from '../types.js';
      export declare const combine: (a: RootType & RuntimeType, b: RootType & RuntimeType) => readonly [RootType & RuntimeType, 10];
      "
    `)
    expect(await readFile(join(dist, 'runtime/escaping.js'), 'utf-8')).toContain(`import("../_external/external.js")`)
    expect(await readFile(join(dist, 'shared/constants.js'), 'utf-8')).toMatchInlineSnapshot(`
      "import { LIMIT } from "./limits.js";
      export const CONSTANT = LIMIT;
      "
    `)
    const files = await readdir(dist, { recursive: true })
    expect(files.filter(file => !file.startsWith('runtime')).sort()).toMatchInlineSnapshot(`
      [
        "_external",
        "_external/external.d.ts",
        "_external/external.js",
        "_external/src",
        "_external/src/types.d.ts",
        "module.d.mts",
        "module.json",
        "module.mjs",
        "routing.d.ts",
        "shared",
        "shared/constants.d.ts",
        "shared/constants.js",
        "shared/limits.d.ts",
        "shared/limits.js",
        "types",
        "types.d.mts",
        "types/middlewares.d.ts",
        "utils",
        "utils.d.mts",
        "utils.mjs",
        "utils/merge.d.mts",
        "utils/merge.mjs",
      ]
    `)
    expect(files.filter(file => /^runtime\/(?:types|server|utils)/.test(file)).sort()).toMatchInlineSnapshot(`
      [
        "runtime/server",
        "runtime/server/limiter.d.ts",
        "runtime/server/limiter.js",
        "runtime/server/uses.d.ts",
        "runtime/server/uses.js",
        "runtime/types.d.ts",
        "runtime/types.js",
        "runtime/utils",
        "runtime/utils/props.d.ts",
        "runtime/utils/props.js",
        "runtime/utils/provider.d.ts",
        "runtime/utils/provider.js",
      ]
    `)
  })

  it('should emit only declarations for files outside the runtime directory that runtime files use as types', async () => {
    const dist = join(runtimeShapeRootDir, 'dist')
    expect(await readFile(join(dist, 'runtime/server/limiter.js'), 'utf-8')).toMatchInlineSnapshot(`
      "import "../disabled/side.js";
      export const limit = (options) => options.maxRequestSizeInBytes;
      "
    `)
    expect(await readFile(join(dist, 'runtime/composables/useLocaleRoute.js'), 'utf-8')).toMatchInlineSnapshot(`
      "export const useLocaleRoute = (route) => route;
      "
    `)
    expect(await readFile(join(dist, 'routing.d.ts'), 'utf-8')).toMatchInlineSnapshot(`
      "import type { RootType } from './_external/src/types.js';
      export interface RouteInfo {
          path: string;
          root: RootType;
      }
      export declare const localizeRoutes: (file: string) => string;
      "
    `)
    for (const file of ['routing.js', 'kit', 'types/middlewares.js', 'types.d.ts', 'types.js', '_external/src/types.js']) {
      expect(existsSync(join(dist, file)), file).toBe(false)
    }
  })

  it('should type imports of build-time aliases as `any` in declarations', async () => {
    const dist = join(runtimeShapeRootDir, 'dist/runtime')
    expect(await readFile(join(dist, 'composables/useThemeConfig.d.ts'), 'utf-8')).toContain('useThemeConfig: () => any;')
    expect(await readFile(join(dist, 'composables/useButton.d.ts'), 'utf-8')).toMatchInlineSnapshot(`
      "export declare const useButton: () => {
          slots: any;
          size: any;
          ui: any;
      };
      "
    `)
    expect(await readFile(join(dist, 'components/Button.d.vue.ts'), 'utf-8')).toMatchInlineSnapshot(`
      "type __VLS_Props = {
          size?: string;
      };
      declare const __VLS_export: import("vue").DefineComponent<__VLS_Props, {
          classes: any[];
      }, {}, {}, {}, import("vue").ComponentOptionsMixin, import("vue").ComponentOptionsMixin, {}, string, import("vue").PublicProps, Readonly<__VLS_Props> & Readonly<{}>, {}, {}, {}, {}, string, import("vue").ComponentProvideOptions, false, {}, any>;
      declare const _default: typeof __VLS_export;
      export default _default;
      "
    `)
    expect(existsSync(join(dist, 'components/Sized.vue.d.ts'))).toBe(true)
  })

  it('should generate declarations with the module\'s own `.nuxt` when the tsconfig takes its types from a playground', async () => {
    expect(routesBuild).toMatch(new RegExp(`\\.\\./tsconfig.json\`? takes its generated types from another app's \`?.nuxt\`?; declarations are generated with \`?.nuxt/tsconfig.json\`? instead. Add a \`?tsconfig.json\`? in the module directory that extends \`?./.nuxt/tsconfig.json\`?. ${guide('module-tsconfig')}`))
    expect(await readFile(join(routesRootDir, 'playground/.nuxt/types/nitro-routes.d.ts'), 'utf-8')).toContain('/api/secret')
    for (const file of await readdir(join(routesRootDir, 'dist'), { recursive: true })) {
      if (file.includes('.')) {
        expect(await readFile(join(routesRootDir, 'dist', file), 'utf-8'), file).not.toMatch(/must-not-be-published|playground|\.nuxt/)
      }
    }
  })

  it('should type the responses of routes the module registers and leave other routes unknown', async () => {
    expect(await readFile(join(routesRootDir, '.nuxt/types/nitro-routes.d.ts'), 'utf-8')).toContain('/api/own')
    const { default: ts } = await import('typescript')
    const files = ts.getParsedCommandLineOfConfigFile(join(routesRootDir, '.nuxt/tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!.fileNames
    expect(files.map(file => relative(routesRootDir, file)).filter(file => file.includes('routes.d.ts')).sort()).toEqual(['../sibling/types/routes.d.ts', 'docs/types/routes.d.ts', 'playground/types/routes.d.ts'])
    expect(await readFile(join(routesRootDir, 'dist/runtime/composables/useOwn.d.ts'), 'utf-8')).toBe(`export declare const useOwn: () => import("nuxt/app").AsyncData<{\n    own: "module-owned";\n} | undefined, import("nuxt/app").NuxtError<unknown> | undefined>;\n`)
    expect(await readFile(join(routesRootDir, 'dist/runtime/composables/useGlobal.d.ts'), 'utf-8')).toBe('export declare const useGlobal: () => Fake.Thing;\n')
    expect(routesBuild).not.toMatch(/type errors? (?:was|were) reported/)
    for (const name of ['useSecret', 'useSibling', 'useDocs']) {
      expect(await readFile(join(routesRootDir, `dist/runtime/composables/${name}.d.ts`), 'utf-8'), name).toBe(`export declare const ${name}: () => import("nuxt/app").AsyncData<unknown, import("nuxt/app").NuxtError<unknown> | undefined>;\n`)
    }
    const component = await readFile(join(routesRootDir, 'dist/runtime/components/Routes.vue.d.ts'), 'utf-8')
    expect(component).toContain('own: import("vue").Ref<{\n        own: "module-owned";\n    } | undefined, {\n        own: "module-owned";\n    } | undefined>;')
    expect(component).toContain('secret: import("vue").Ref<unknown, unknown>;')
  })

  it('should give every relative specifier in runtime declarations an extension that resolves', async () => {
    const unresolved = async (dir: string) => {
      const failures: string[] = []
      for (const entry of await readdir(dir, { recursive: true })) {
        if (!/\.d\.[^/]*ts$/.test(entry)) {
          continue
        }
        const file = join(dir, entry)
        for (const [, specifier] of (await readFile(file, 'utf-8')).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]*)['"]/g)) {
          const target = join(dirname(file), specifier!)
          const candidates = specifier!.endsWith('.js')
            ? [target.replace(/\.js$/, '.d.ts')]
            : specifier!.endsWith('.mjs')
              ? [target.replace(/\.mjs$/, '.d.mts')]
              : specifier!.endsWith('.vue')
                ? [`${target}.d.ts`, target.replace(/\.vue$/, '.d.vue.ts')]
                : specifier!.endsWith('.css') ? [target] : []
          if (!candidates.some(candidate => existsSync(candidate))) {
            failures.push(`${entry}: ${specifier}`)
          }
        }
      }
      return failures
    }
    expect(await unresolved(join(runtimeShapeRootDir, 'dist'))).toEqual([])
    expect(await unresolved(runtimeDir)).toEqual([])
  })

  it('should name inferred types by package when the generated tsconfig maps a package to its real path', async () => {
    const types = await readFile(join(portableRootDir, 'dist/module.d.mts'), 'utf-8')
    expect(types).toMatch(/Thing<\{/)
    expect(types).toMatch(/["']fake-schema["']/)
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

      export { type ModuleHooks, type ModuleOptions, type ModulePublicRuntimeConfig, type ModuleRuntimeConfig, type ModuleRuntimeHooks, default } from './module.mjs'
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

      export { type ModuleHooks, type ModulePublicRuntimeConfig, type ModuleRuntimeConfig, type ModuleRuntimeHooks, default } from './module.mjs'
      "
    `)
  })

  it('should generate module metadata as separate JSON file', async () => {
    const meta = await readFile(join(distDir, 'module.json'), 'utf-8')
    const tsdownPkg = await readPackageJSON('tsdown')
    expect(JSON.parse(meta)).toMatchObject(
      {
        builder: {
          '@nuxt/module-builder': version,
          'tsdown': tsdownPkg.version,
        },
        configKey: 'myModule',
        name: 'my-module',
        version: '1.0.0',
      },
    )
  })

  it('should generate module metadata when the module entry imports runtime code', async () => {
    const meta = await readFile(join(thirdDistDir, 'module.json'), 'utf-8')
    expect(JSON.parse(meta)).toMatchObject({ configKey: 'myModule', name: 'my-module' })
  })

  it('should generate module metadata when the module entry re-exports from a build-only alias', async () => {
    await exec('pnpm', ['nuxt-module-build', 'build', '--stub', thirdRootDir], { nodeOptions: { cwd: repoRoot }, throwOnError: true })
    const meta = JSON.parse(await readFile(join(thirdDistDir, 'module.json'), 'utf-8'))
    expect(meta).toMatchObject({ configKey: 'myModule', name: 'my-module' })

    // leave the bundled output in place for the remaining assertions
    await exec('pnpm', ['prepack'], { nodeOptions: { cwd: thirdRootDir }, throwOnError: true })
  })

  it('should generate typed plugin', async () => {
    const pluginDts = await readFile(join(distDir, 'runtime/plugins/plugin.d.ts'), 'utf-8')
    const appAlias = `import\\("nuxt/app"\\)`
    expect(pluginDts).toMatch(/^export type SharedTypeFromRuntime = 'shared-type';$/m)
    expect(pluginDts).toMatch(
      new RegExp(
        `declare const _default: ${appAlias}\\.Plugin<\\{\\s*injection: "injected";\\s*\\}> & ${appAlias}\\.ObjectPlugin<\\{\\s*injection: "injected";\\s*\\}>;`,
      ),
    )
    expect(pluginDts).toMatch(/^export default _default;$/m)
  })

  it('should not leak build-only virtual aliases into emitted runtime declarations', async () => {
    const files = await readdir(runtimeDir, { recursive: true })
    const declarations = files.filter(file => /\.d\.[^/]*ts$/.test(file))
    expect(declarations.length).toBeGreaterThan(0)
    for (const file of declarations) {
      const contents = await readFile(join(runtimeDir, file), 'utf-8')
      expect(contents, file).not.toMatch(/(["'])#app(?:\/[^"']*)?\1/)
      expect(contents, file).not.toMatch(/import\("#app(?:\/[^"]*)?"\)/)
    }
  })

  it('should resolve every shape of `#app` alias in runtime declarations', async () => {
    const declaration = await readFile(join(runtimeDir, 'composables/useAliasedApp.d.ts'), 'utf-8')
    expect(declaration).toMatch(/declare const useAppInstance: \(\) => import\("nuxt\/app"\)\.NuxtApp;/)
    expect(declaration).toMatch(/declare const useAppRouter: \(\) => import\("vue-router"\)\./)
    expect(declaration).toMatch(/declare const useAppCookie: \(name: string\) => import\("nuxt\/app"\)\.CookieRef</)
    const deepDeclaration = await readFile(join(runtimeDir, 'composables/useAppNuxt.d.ts'), 'utf-8')
    expect(deepDeclaration).toMatch(/declare const useAppFromNuxt: \(\) => import\("nuxt\/app"\)\.NuxtApp;/)
  })

  it('should correctly add extensions to imports from runtime/ directory', async () => {
    const moduleDts = await readFile(join(distDir, 'module.d.mts'), 'utf-8')
    const runtimeImport = findStaticImports(moduleDts).find(i => i.specifier.includes('runtime'))
    expect(runtimeImport!.code.trim()).toMatchInlineSnapshot(`"import { SharedTypeFromRuntime } from "./runtime/plugins/plugin.js";"`)
  })

  it('should externalise runtime imports made through relative, aliased and `.vue` specifiers', async () => {
    const moduleCode = await readFile(join(thirdDistDir, 'module.mjs'), 'utf-8')
    const specifiers = findStaticImports(moduleCode).map(i => i.specifier).filter(s => s.includes('runtime'))
    expect(specifiers.sort()).toMatchInlineSnapshot(`
      [
        "./runtime/components/TestMe.vue",
        "./runtime/composables/useAppNuxt.js",
        "./runtime/composables/useWrappedFetch.js",
      ]
    `)
  })

  it('should add extensions to runtime imports when the path has spaces or non-ASCII characters', async () => {
    const moduleDts = await readFile(join(encodedRootDir, 'dist/module.d.mts'), 'utf-8')
    const runtimeImport = findStaticImports(moduleDts).find(i => i.specifier.includes('runtime'))
    expect(runtimeImport!.code.trim()).toBe(`import { SharedTypeFromRuntime } from "./runtime/plugins/plugin.js";`)
  })

  it('should build a module under a path with spaces and non-ASCII characters', async () => {
    const encodedDistDir = join(encodedRootDir, 'dist')
    const runtimeSpecifiers = (code: string) => findStaticImports(code).map(i => i.specifier).filter(s => s.includes('runtime')).sort()

    expect(runtimeSpecifiers(await readFile(join(encodedDistDir, 'module.mjs'), 'utf-8'))).toEqual([
      './runtime/components/TestMe.vue',
      './runtime/composables/useAppNuxt.js',
      './runtime/composables/useWrappedFetch.js',
    ])
    expect(JSON.parse(await readFile(join(encodedDistDir, 'module.json'), 'utf-8'))).toMatchObject({ name: 'my-module', configKey: 'myModule' })
    expect(await readFile(join(encodedDistDir, 'types.d.mts'), 'utf-8')).toContain('from \'./module.mjs\'')

    const runtimeFiles = (dir: string) => readdir(join(dir, 'runtime'), { recursive: true }).then(files => files.sort())
    expect(await runtimeFiles(encodedDistDir)).toEqual(await runtimeFiles(thirdDistDir))
  })

  it('should stub a module under a path with spaces and non-ASCII characters', async () => {
    const stubDir = join(encodedRootDir, '.stub')
    try {
      await exec('pnpm', ['nuxt-module-build', 'build', '--stub', '--outDir', '.stub', encodedRootDir], { nodeOptions: { cwd: repoRoot }, throwOnError: true })
      expect(await readFile(join(stubDir, 'module.mjs'), 'utf-8')).toContain('from \'../src/module.ts\'')
      expect(JSON.parse(await readFile(join(stubDir, 'module.json'), 'utf-8'))).toMatchObject({ name: 'my-module', configKey: 'myModule' })
    }
    finally {
      await rm(stubDir, { force: true, recursive: true })
    }
  }, 60 * 1000)

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

    const componentDeclarationFile2 = await readFile(join(distDir, 'runtime/components/TestMeSetup.d.vue.ts'), 'utf-8')
    await expect(componentDeclarationFile2.replace(/\r\n/g, '\n')).toMatchFileSnapshot('__snapshots__/TestMeSetup.d.vue.ts')
  })

  it('should generate wrapped composables', async () => {
    const componentFile = await readFile(join(distDir, 'runtime/composables/useWrappedFetch.d.ts'), 'utf-8')
    // `null` vs `undefined` error-type difference between Nuxt 3 and 4+ is intentional.
    // Nuxt 4+ moved the default error from `FetchError` to `NuxtError<unknown>` (nuxt/nuxt#35346); accept both until it lands in a release.
    const expectedErrorType = satisfies(nuxtVersion, '^3') ? 'null' : 'undefined'
    const errorType = satisfies(nuxtVersion, '^3')
      ? 'import\\("ofetch"\\)\\.FetchError<any>'
      : '(?:import\\("ofetch"\\)\\.FetchError<any>|import\\("nuxt/app"\\)\\.NuxtError<unknown>)'
    expect(componentFile).toMatch(
      new RegExp(
        `^export declare const useWrappedFetch: \\(\\) => import\\("nuxt/app"\\)\\.AsyncData<unknown, ${errorType} \\| ${expectedErrorType}>;$`,
        'm',
      ),
    )
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
