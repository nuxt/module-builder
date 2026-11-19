import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { version as nuxtVersion } from 'nuxt/package.json'
import { join, relative, resolve } from 'pathe'
import { version as tsdownVersion } from 'tsdown/package.json'
import { satisfies } from 'verkit'
import { beforeAll, describe, expect, it } from 'vitest'

import { version } from '../package.json'
import type { PackageJson } from '../src/utils.ts'
import { npmPackFromPnpmScript, packProbeArgs, packProbeContext } from './pack-env.ts'
import type { Result } from './utils.ts'
import { bin, builderImport, cli, cliBin, exampleDir, exists, fixture, listFiles, read, repoRoot, run, staticImports, succeed, tsdownBin, unresolvedSpecifiers, withoutGuide } from './utils.ts'

const LEGACY_TSCONFIG = { extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground', '**/tsdown.config.ts'] }
const ISOLATED = {
  'tsconfig.json': JSON.stringify({ ...LEGACY_TSCONFIG, compilerOptions: { isolatedDeclarations: true } }),
  'src/utils.ts': 'export const myModuleUtils = (): void => {}\n',
}
const REFERENCES = (node: string) => JSON.stringify({
  files: [],
  exclude: ['dist', 'node_modules', 'playground'],
  references: [node, './.nuxt/tsconfig.app.json', './.nuxt/tsconfig.server.json', './.nuxt/tsconfig.shared.json'].map(path => ({ path })),
})

const TEST_TSCONFIG = {
  extends: './.nuxt/tsconfig.node.json',
  compilerOptions: { tsBuildInfoFile: './.nuxt/tsconfig.test.tsbuildinfo' },
  include: ['./.nuxt/nuxt.d.ts', './.nuxt/nuxt.node.d.ts', './test', './*.config.*'],
  exclude: ['./test/nuxt', './test/fixtures'],
}

const annotate = (source: string) => [
  `import type { NuxtModule } from '@nuxt/schema'`,
  source.replace(/export default defineNuxtModule(<ModuleOptions>)?\(\{/, (_, options = '') => `const module: NuxtModule${options} = defineNuxtModule${options}({`),
  'export default module',
].join('\n')

const minimalModule = (name: string) => `import { defineNuxtModule } from '@nuxt/kit'\n\nexport default defineNuxtModule({\n  meta: { name: '${name}', configKey: '${name}' },\n  setup() {},\n})\n`

const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`

const fakeCache = {
  'node_modules/fake-cache/package.json': JSON.stringify({ name: 'fake-cache', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
  'node_modules/fake-cache/index.js': `export const defineCached = handler => handler\n`,
  'node_modules/fake-cache/index.d.ts': `import type { Handler } from 'fake-h3'\nexport declare const defineCached: (handler: () => string) => Handler\n`,
  'node_modules/fake-cache/node_modules/fake-h3/package.json': JSON.stringify({ name: 'fake-h3', type: 'module', exports: { '.': { types: './index.d.ts' } } }),
  'node_modules/fake-cache/node_modules/fake-h3/index.d.ts': `export interface Handler { (): string, __h3: 2 }\n`,
}

const VALUE_EXPORTS = `export function defineMyModuleConfig(): void {}
export const myModuleVersion = '1.0.0'
export const Mode = { Light: 0, Dark: 1 } as const
export type Mode = typeof Mode[keyof typeof Mode]
`

const consumer = {
  'playground/consumer.ts': `import { Mode, defineMyModuleConfig, myModuleVersion } from 'my-module'
import type { ModuleOptions } from 'my-module'

defineMyModuleConfig()
const options: ModuleOptions = { apiKey: myModuleVersion }
const light: number = Mode.Light
const dark: Mode = Mode.Dark
void [light, dark, options]
`,
  'playground/consumer.tsconfig.json': JSON.stringify({
    compilerOptions: { moduleResolution: 'bundler', module: 'ESNext', target: 'ESNext', lib: ['ESNext'], strict: true, noEmit: true, skipLibCheck: true },
    include: ['consumer.ts'],
  }),
}

const runtimeSpecifiers = (code: string) => staticImports(code).map(i => i.specifier).filter(s => s.includes('runtime')).sort()

const dirs: Record<string, string> = {}
let sourceWithoutDist = false
const results: Record<string, Result> = {}
const result = (name: string) => {
  const found = results[name]
  if (!found) {
    throw new Error(`\`${name}\` did not run, as a step before it failed`)
  }
  return found
}
const output = (name: string) => result(name).output
const step = async (name: string, result: Promise<Result>) => {
  const settled = await result
  results[name] = settled
  return settled
}
const inOrder = async (...steps: Array<[name: string, run: () => Promise<Result>]>) => {
  for (const [name, run] of steps) {
    if ((await step(name, run())).exitCode !== 0) {
      return false
    }
  }
  return true
}

beforeAll(async () => {
  const examplePkg = JSON.parse(await readFile(join(exampleDir, 'package.json'), 'utf-8'))
  const base = await fixture('.temp-cli/base', { files: { 'tsconfig.json': JSON.stringify(LEGACY_TSCONFIG) } })
  await succeed(cli(['prepare', base]))
  const from = base

  dirs.runtime = await fixture('.temp-cli/runtime with spaces ü', {
    from,
    module: source => [
      `import type { DeepPartial } from 'fake-types'`,
      `import type FakeCjs from 'fake-cjs-types'`,
      `import { defineThing } from 'fake-kit'`,
      source,
      `import { name } from './runtime/utils/name.ts'`,
      `import { aliased } from '#runtime/utils/aliased'`,
      `import { useShape } from './runtime/composables/useShape.ts'`,
      `import type TestMe from './runtime/components/TestMe.vue'`,
      `import type JsxComponent from './runtime/components/JsxComponent.tsx'`,
      `export const runtimeRefs = [name, aliased, useShape]`,
      `export type TestMeType = typeof TestMe`,
      `export type JsxComponentType = typeof JsxComponent`,
      `export type { NuxtApp } from '#app'`,
      `export interface ExtraOptions { deep?: DeepPartial<{ a: string }>, cjs?: FakeCjs.Options }`,
      `export const thing = defineThing({ name: 'portable' })`,
      '',
    ].join('\n'),
    pkg: pkg => ({ ...pkg, imports: { '#runtime/*': './src/runtime/*.ts' } }),
    files: {
      'src/runtime/composables/useShape.ts': `import { shape } from '../utils/shape.ts'\n\nexport const useShape = (): string => shape\n`,
      'src/runtime/utils/name.ts': `export const name: string = 'name'\n`,
      'src/runtime/utils/aliased.ts': `export const aliased: string = 'aliased'\n`,
      'src/runtime/utils/shape.ts': `export const shape: string = 'shape'\n`,
      'src/runtime/components/JsxCard.vue': `<script setup lang="ts">\nimport JsxComponent from './JsxComponent'\n</script>\n\n<template>\n  <JsxComponent />\n</template>\n`,
      'src/runtime/components/JsxSlot.tsx': `import { defineComponent } from 'vue'\nimport { useNuxtApp } from '#app'\nimport JsxComponent from './JsxComponent'\n\nexport const useSlotApp = () => useNuxtApp()\n\nexport default defineComponent((_, { slots }) => () => <section><JsxComponent />{slots.default?.()}</section>)\n`,
      'src/runtime/server/render.tsx': `import { useSlotApp } from '../components/JsxSlot'\nimport { strong } from '../utils/strong'\n\nexport type SlotApp = ReturnType<typeof useSlotApp>\n\nexport const render = (label: string) => <p>{strong(label)}</p>\n`,
      'src/runtime/server/render.stories.ts': `import JsxSlot from '../components/JsxSlot'\n\nexport const tested = JsxSlot\n`,
      'src/runtime/utils/strong.tsx': `import { bold } from './bold'\n\nexport const strong = (label: string) => <strong>{bold(label)}</strong>\n`,
      'src/runtime/utils/bold.tsx': `export const bold = (label: string) => <b>{label}</b>\n`,
      'src/runtime/utils/label.tsx': `export const label = <span>label</span>\n`,
      'node_modules/fake-cjs-types/package.json': JSON.stringify({ name: 'fake-cjs-types', types: './index.d.ts' }),
      'node_modules/fake-cjs-types/index.d.ts': `declare namespace FakeCjs { interface Options { level: number } }\nexport = FakeCjs\n`,
      'node_modules/fake-dep/package.json': JSON.stringify({ name: 'fake-dep', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      'node_modules/fake-dep/index.js': `export const helper = () => 'bundled-fake-dep'\n`,
      'node_modules/fake-dep/index.d.ts': `export declare const helper: () => string\n`,
      'node_modules/fake-types/package.json': JSON.stringify({ name: 'fake-types', types: './index.d.ts' }),
      'node_modules/fake-types/index.d.ts': `export type DeepPartial<T> = { [K in keyof T]?: DeepPartial<T[K]> }\n`,
      [`${store('fake-schema')}/package.json`]: JSON.stringify({ name: 'fake-schema', types: './index.d.ts' }),
      [`${store('fake-schema')}/index.d.ts`]: `export interface Thing<T> { options: T }\n`,
      [`${store('fake-kit')}/package.json`]: JSON.stringify({ name: 'fake-kit', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-kit')}/index.d.ts`]: `import type { Thing } from 'fake-schema'\nexport declare function defineThing<T>(options: T): Thing<T>\n`,
      [`${store('fake-kit')}/index.js`]: `export const defineThing = options => ({ options })\n`,
      '.nuxt/nuxt.d.ts': source => `/// <reference types="fake-schema" />\n${source}`,
      'src/runtime/server/routes/[...slug].ts': `export default (slug: string) => slug\n`,
      'src/runtime/utils/self.ts': `import type { ModuleOptions } from 'my-module'\n\nexport const getApiKey = (options: ModuleOptions) => options.apiKey\n`,
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
      'src/runtime/utils/options.ts': `import type { DeepPartial } from 'fake-types'\nimport { helper } from 'fake-dep'\n\nexport type Options = DeepPartial<{ a: { b: string } }>\nexport const defineOptions = (options: Options) => ({ options, helper })\n`,
      'src/runtime/utils/typo.ts': `export const count: number = 'one'\nexport const double = (value: number): number => value * 2\n`,
      'src/runtime/components/Typo.vue': `<script setup lang="ts">\nconst props = defineProps<{ label: string }>()\nconst count: number = 'one'\n</script>\n\n<template>\n  <span>{{ props.label }} {{ count }}</span>\n</template>\n`,
      'src/runtime/components/Sized.vue': `<script lang="ts">\nexport interface Props {\n  size?: 'xs' | 'sm' | 'md'\n}\n</script>\n\n<script setup lang="ts">\nconst props = defineProps<Props>()\n</script>\n\n<template>\n  <span :class="props.size" />\n</template>\n`,
      'src/runtime/composables/useSize.ts': `import { computed } from 'vue'\nimport type { Props } from '../components/Sized.vue'\n\nexport function useSize(props: Props) {\n  return computed(() => props.size)\n}\n`,
    },
    paths: { '#fixture-cache': ['../src/runtime/cache/lru'], 'fake-schema': [`../${store('fake-schema')}`] },
    links: {
      'node_modules/.pnpm/fake-kit@1.0.0/node_modules/fake-schema': store('fake-schema'),
      'node_modules/fake-schema': store('fake-schema'),
      'node_modules/fake-kit': store('fake-kit'),
    },
  })

  dirs.runtimeLink = join(repoRoot, '.temp-cli/runtime-link')
  await rm(dirs.runtimeLink, { force: true })
  await symlink(dirs.runtime, dirs.runtimeLink)

  dirs.isolated = await fixture('.temp-cli/isolated', {
    from,
    module: source => annotate(`${source}\n${VALUE_EXPORTS}`),
    remove: ['.nuxt'],
    files: {
      ...ISOLATED,
      ...consumer,
      'src/runtime/styles/card.css': `@import "./base.css";\n\n.card {\n  user-select: none;\n  & .title { font-weight: bold; }\n  &:hover { color: rebeccapurple; }\n}\n`,
      'src/runtime/styles/base.css': `.base { margin: 0px 0px; }\n`,
      'src/runtime/styles/_variables.scss': `$primary: #00dc82;\n`,
      'src/runtime/styles/theme.scss': `@use "variables" as v;\n.theme { color: v.$primary; .nested { padding: 1px; } }\n`,
      'src/runtime/styles/indented.sass': `.indented\n  color: blue\n`,
      'src/runtime/styles/legacy.less': `@c: red;\n.less { color: @c; }\n`,
      'src/runtime/types/ambient.d.ts': `declare global { interface Window { __fixture: true } }\nexport {}\n`,
      'src/runtime/types/app.d.ts': `import type { NuxtApp } from '#app'\nexport type App = NuxtApp\n`,
      'src/runtime/plugins/styled.ts': `import '../styles/card.css'\nimport '../styles/theme.scss'\n\nexport const styled = true\n`,
    },
  })

  dirs.types = await fixture('.temp-cli/types', {
    from,
    module: source => `${source.replace('export interface ModuleOptions', 'interface ModuleOptions')}\n${VALUE_EXPORTS}`,
    files: consumer,
  })

  dirs.minimal = await fixture('.temp-cli/minimal', {
    from,
    config: `export default {\n  plugins: [builder({ entries: ['./src/utils', { input: 'src/components/', outDir: 'dist/components' }] })],\n}\n`,
    module: annotate(minimalModule('minimal')),
    remove: ['src/runtime'],
    files: {
      ...ISOLATED,
      ...Object.fromEntries(await Promise.all(['TestMe.vue', 'TestMe.css', 'TestMeSetup.vue'].map(async file => [`src/components/${file}`, await read(exampleDir, 'src/runtime/components', file)]))),
    },
  })

  dirs.shape = await fixture('.temp-cli/shape', {
    from,
    config: `export default {\n  plugins: [builder({ entries: ['./src/utils', './src/utils/merge.ts', './src/data.json'] })],\n}\n`,
    files: {
      '.nuxt/app.config.ts': `export default { theme: { buildMachineOnly: 'must-not-be-published' as const } }\n`,
      'external.ts': `export const answer = 42\n`,
      ...Object.fromEntries(['fake-polyfill', 'fake-register'].flatMap(name => [
        [`node_modules/${name}/package.json`, JSON.stringify({ name, type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } })],
        [`node_modules/${name}/index.js`, `globalThis.__order = [...globalThis.__order ?? [], '${name}']\n`],
        [`node_modules/${name}/index.d.ts`, `export {}\n`],
      ])),
      'src/data.json': `{ "answer": 42 }\n`,
      'src/utils/merge.ts': `export const merge = <T extends object>(a: T, b: T): T => ({ ...a, ...b })\n`,
      'src/shared/constants.ts': `import { LIMIT } from './limits'\n\nexport const CONSTANT = LIMIT\n`,
      'src/shared/limits.ts': `export const LIMIT = 10\n`,
      'src/types.ts': `export interface RootType { root: string }\n`,
      'src/types/middlewares.ts': `export type RequestSizeLimiter = { maxRequestSizeInBytes: number }\n`,
      'src/runtime/server/limiter.ts': `import { type RequestSizeLimiter } from '../../types/middlewares'\nimport {} from 'nuxt/app'\nimport '../disabled/side'\n\nexport const limit = (options: RequestSizeLimiter) => options.maxRequestSizeInBytes\n`,
      'src/routing.ts': `import { readFileSync } from 'node:fs'\nimport { generate } from './kit/gen'\nimport type { RootType } from './types'\n\nexport interface RouteInfo { path: string, root: RootType }\nexport const localizeRoutes = (file: string): string => generate(readFileSync(file, 'utf8'))\n`,
      'src/kit/gen.ts': `import { createHash } from 'node:crypto'\n\nexport const generate = (input: string) => createHash('sha1').update(input).digest('hex')\n`,
      'src/runtime/composables/useLocaleRoute.ts': `import { RouteInfo } from '../../routing'\n\nexport const useLocaleRoute = (route: RouteInfo) => route\n`,
      'src/runtime/types.ts': `export interface RuntimeType { runtime: string }\n`,
      'src/runtime/server/uses.ts': [
        `import { merge } from '../../utils/merge'`,
        `import { CONSTANT } from '../../shared/constants'`,
        `import type { RootType } from '../../types'`,
        `import type { RuntimeType } from '../types'`,
        ``,
        `export const combine = (a: RootType & RuntimeType, b: RootType & RuntimeType) => [merge(a, b), CONSTANT] as const`,
        ``,
      ].join('\n'),
      'src/runtime/escaping.ts': `export const load = () => import('../../external')\n`,
      'src/runtime/composables/mock.ts': `export const defineThing = () => 'mock'\n`,
      'src/runtime/disabled/composables/defineThing.ts': `export { defineThing } from '../../composables/mock'\n`,
      'src/runtime/disabled/index.ts': `import './side'\nexport { defineThing } from './composables/defineThing'\n`,
      'src/runtime/disabled/side.ts': `globalThis.__side = true\n`,
      'src/runtime/order/interleaved.ts': [
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
      'src/runtime/order/levels.ts': `export const level = 1\n`,
      'src/runtime/order/reexported.ts': `export const reexported = 1\n`,
      'src/runtime/order/effect.ts': `globalThis.__effect = true\n`,
      'src/runtime/order/order.css': `.order { color: red }\n`,
      'src/runtime/content/index.ts': `export * from '../components/TestMe.vue'\nexport * from '../components/TestMeSetup.vue'\nexport * from './prose'\n`,
      'src/runtime/content/prose.ts': `export * from './levels'\nexport interface ProseThing { title: string }\n`,
      'src/runtime/content/levels.ts': `export const proseLevel = 1\n`,
      'src/runtime/utils/provider.ts': `import type { ModuleOptions } from '../../module'\n\nexport const defineProvider = (options: ModuleOptions) => options\n`,
      'src/runtime/utils/props.ts': `export interface BaseProps { size?: number }\n`,
      'src/runtime/composables/useThemeConfig.ts': `import appConfig from '#build/app.config'\n\nexport const useThemeConfig = () => appConfig.theme\n`,
      'src/runtime/composables/useButton.ts': `import theme, { variants } from '#build/ui/button'\nimport * as config from '#build/app.config'\n\nexport const useButton = () => ({ slots: theme.slots, size: variants.size, ui: config.default.ui })\n`,
      'src/runtime/components/Button.vue': `<script setup lang="ts">\nimport theme, { variants } from '#build/ui/button'\nimport * as config from '#build/app.config'\n\nconst props = defineProps<{ size?: string }>()\nconst classes = [theme.base, variants[props.size ?? 'md'], config.default.ui]\ndefineExpose({ classes })\n</script>\n\n<template>\n  <button :class="classes" />\n</template>\n`,
      'src/runtime/components/Sized.vue': `<script setup lang="ts">\nimport type { BaseProps } from '../utils/props'\nimport { useThemeConfig } from '../composables/useThemeConfig'\n\ndefineProps<BaseProps>()\nconst theme = useThemeConfig()\n</script>\n\n<template>\n  <div>{{ theme }}</div>\n</template>\n`,
    },
  })

  dirs.loader = await fixture('.temp-cli/loader', {
    from,
    module: `import { deps } from './deps.ts'\nimport { deep } from './deep/a.ts'\n${minimalModule('my-module')}\nexport const loaded = [deps, deep]\nexport { nativeValue } from './native-helper.ts'\nexport { internal } from '#internal/value'\n`,
    remove: ['.nuxt'],
    pkg: pkg => ({ ...pkg, imports: { '#internal/*': './src/internal/*.ts' } }),
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '*': ['./src/*'] } } }),
      'src/@nuxt/kit.ts': 'export const defineNuxtModule = (_: unknown) => ({ SHADOWED: true })\n',
      'src/native-helper.ts': `import { inner } from './nested/inner.ts'\n\nexport const nativeValue: string = inner\n`,
      'src/nested/inner.ts': `export const inner: string = 'loaded helper'\n`,
      'src/internal/value.ts': `export const internal: string = 'through imports'\n`,
      'node_modules/fake-cjs-marker/package.json': JSON.stringify({ name: 'fake-cjs-marker', version: '1.0.0', main: 'index.js' }),
      'node_modules/fake-cjs-marker/index.js': `const marker = 'mentions import.meta in a string'\nmodule.exports = { value: marker.length }\n`,
      'node_modules/fake-esm-split/package.json': JSON.stringify({ name: 'fake-esm-split', version: '1.0.0', type: 'module', exports: { '.': { import: './index.js', require: './index.cjs' } } }),
      'node_modules/fake-esm-split/index.js': `export { value } from './inner.js'\nexport { other } from './other.js'\n`,
      'node_modules/fake-esm-split/inner.js': `import cjs from 'fake-cjs-marker'\nexport const value = cjs.value\n`,
      'node_modules/fake-esm-split/other.js': `import cjs from 'fake-cjs-marker'\nexport const other = cjs.value + 1\n`,
      'node_modules/fake-esm-split/index.cjs': `module.exports = { value: 0, other: 1 }\n`,
      'src/deps.ts': `// @ts-ignore untyped\nimport cjs from 'fake-cjs-marker'\n// @ts-ignore untyped\nimport { value, other } from 'fake-esm-split'\n\nexport const deps: unknown[] = [cjs, value, other]\n`,
      'src/deep/a.ts': `export { deep } from './b.ts'\n`,
      'src/deep/b.ts': `import pkg from '../../package.json' with { type: 'json' }\n\nexport const deep: string = pkg.name\n`,
      'probe.ts': `import type Module from './.nuxt/module-builder/types.mjs'\n\nexport const meta: Promise<{ configKey?: string }> = ({} as typeof Module).getMeta!()\n`,
    },
  })

  dirs.unloadable = await fixture('.temp-cli/unloadable', {
    from,
    module: source => `import { name as packageName } from '../package.json'
import { Level } from './levels.ts'

enum Mode { Stub = 'stub' }
class Holder { constructor(public value: string) {} }
${source.replace(`name: 'my-module'`, 'name: new Holder(`${packageName}-${<string>Mode.Stub}-${Level.High}`).value')}
export { myModuleUtils } from './utils.js'
export { helper } from './helpers'
export { kit } from './kit'
export type { Kit } from './kit'
`,
    files: {
      'src/levels.ts': `export enum Level { High = 'high' }\n`,
      'src/helpers.ts': `export const helper = (): string => 'helper'\n`,
      'src/kit/index.ts': `export const kit = (): string => 'kit'\nexport type Kit = ReturnType<typeof kit>\n`,
    },
  })

  dirs.unloadableDist = await fixture('.temp-cli/unloadable-dist', {
    from,
    module: source => `${source}\nif (new URL(import.meta.url).pathname.endsWith('.mjs')) {\n  throw new Error('fails once built')\n}\n`,
  })

  dirs.isolatedError = await fixture('.temp-cli/isolated-error', { from, files: { 'tsconfig.json': ISOLATED['tsconfig.json'] } })

  dirs.referencedSource = await fixture('.temp-cli/referenced-source', {
    remove: ['src/runtime/components'],
    files: {
      'src/kit/gen.ts': `import { myModuleUtils } from '../utils.ts'\n\nexport const gen = () => myModuleUtils\n`,
      'src/runtime/composables/useGen.ts': `import { gen } from '../../kit/gen.ts'\n\nexport const useGen = () => gen()\n`,
    },
  })

  dirs.typeError = await fixture('.temp-cli/type-error', {
    from,
    remove: ['src/runtime/components'],
    files: {
      ...fakeCache,
      'src/runtime/utils.ts': `export const Anonymous = class { private secret = 1 }\n`,
      'src/runtime/server/cached.ts': `import { defineCached } from 'fake-cache'\n\nexport const defineCachedHandler = defineCached(() => 'cached')\n`,
    },
  })

  dirs.vueError = await fixture('.temp-cli/vue-error', {
    from,
    module: minimalModule('vue-error'),
    remove: ['src/runtime'],
    files: {
      ...fakeCache,
      'src/runtime/components/Cached.vue': `<script lang="ts">\nimport { defineCached } from 'fake-cache'\n\nexport const cachedHandler = defineCached(() => 'cached')\nexport default {}\n</script>\n\n<template>\n  <span>cached</span>\n</template>\n`,
      'src/runtime/server/cached.ts': `import { defineCached } from 'fake-cache'\n\nexport const defineCachedHandler = defineCached(() => 'cached')\n`,
    },
  })

  dirs.solution = await fixture('.temp-cli/solution', {
    from,
    files: {
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.server.json' }] }),
      'tsconfig.app.json': JSON.stringify({ extends: './.nuxt/tsconfig.json', include: ['.nuxt/nuxt.d.ts', 'src/**/*'], exclude: ['src/runtime/server/**'] }),
      'tsconfig.server.json': JSON.stringify({ extends: './.nuxt/tsconfig.json', compilerOptions: { paths: { '#server-only': ['./src/runtime/server/only.ts'] } }, include: ['src/runtime/server/**/*'] }),
      'src/runtime/server/only.ts': `export interface ServerOnly { id: string }\n`,
      'src/runtime/server/api/[id].get.ts': `import type { ServerOnly } from '#server-only'\n\nexport default (value: ServerOnly) => value.id\n`,
    },
  })

  const loggerStore = store('fake-logger')
  const parent = await fixture('.temp-cli/parent', {
    from,
    files: {
      [`${loggerStore}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.mts', default: './dist/index.mjs' }, './utils': { types: './dist/utils.d.mts', default: './dist/utils.mjs' } } }),
      [`${loggerStore}/dist/utils.d.mts`]: `export declare const noop: () => void\n`,
      [`${loggerStore}/dist/utils.mjs`]: `export const noop = () => {}\n`,
      [`${loggerStore}/dist/core.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\n`,
      [`${loggerStore}/dist/core.d.mts`]: `export interface LoggerInstance { log: (message: string) => void }\n`,
      [`${loggerStore}/dist/index.d.ts`]: `import type { LoggerInstance } from './core'\nexport type { LoggerInstance }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${loggerStore}/dist/index.d.mts`]: `import type { LoggerInstance } from './core.mjs'\nexport type { LoggerInstance }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${loggerStore}/dist/index.mjs`]: `export const createLogger = () => ({ log: console.log })\n`,
      'src/runtime/logger.ts': `import { createLogger } from 'fake-logger'\nimport { noop } from 'fake-logger/utils'\n\nexport const logger = createLogger()\nexport const silence = noop\n`,
    },
    paths: { 'fake-logger': [`../${loggerStore}`] },
  })
  dirs.parent = join(parent, 'packages/mod')
  await mkdir(join(dirs.parent, 'node_modules'), { recursive: true })
  for (const file of ['src', 'package.json', 'tsdown.config.ts']) {
    await rename(join(parent, file), join(dirs.parent, file))
  }
  await symlink(join(parent, loggerStore), join(dirs.parent, 'node_modules/fake-logger'))

  const { build: _, ...sourcePkg } = examplePkg
  dirs.routes = await fixture('.temp-cli/routes/mod', {
    from,
    module: source => source
      .replace('import { defineNuxtModule, addPlugin, createResolver }', 'import { defineNuxtModule, addPlugin, addServerHandler, createResolver }')
      .replace(`addPlugin(resolver.resolve('./runtime/plugins/plugin'))`, `addPlugin(resolver.resolve('./runtime/plugins/plugin'))\n    addServerHandler({ route: '/api/own', handler: resolver.resolve('./runtime/server/api/own') })`),
    remove: ['tsconfig.json'],
    pkg: () => sourcePkg,
    files: {
      '.nuxtrc': source => `${source.trimEnd()}\nworkspaceDir=..\n`,
      '../tsconfig.json': JSON.stringify({ extends: './mod/playground/.nuxt/tsconfig.json', compilerOptions: { types: ['fake-global-types'] }, exclude: ['**/dist', '**/node_modules', '**/tsdown.config.ts'] }),
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
    },
  })

  const shapeOptions = (outDir: string) => `{ entries: [{ input: './src/utils', name: 'helpers' }, { input: 'src/shared/', outDir: '${outDir}/shared' }] }`
  const shapes = {
    object: `export default {\n  outDir: 'out',\n  sourcemap: true,\n  plugins: [builder(${shapeOptions('out')})],\n}\n`,
    array: `export default [\n  { entry: { cli: 'src/cli.ts' }, outDir: 'dist-cli', dts: false },\n  { plugins: [builder(${shapeOptions('out')})], outDir: 'out' },\n]\n`,
    function: `export default (_, { watch: { restart } }) => ({\n  plugins: [Promise.resolve(builder(${shapeOptions('dist')}))],\n})\n`,
  }
  for (const [shape, config] of Object.entries(shapes)) {
    dirs[shape] = await fixture(`.temp-cli/${shape}-export`, {
      config,
      remove: ['.nuxt'],
      module: source => `${source}export { other } from './shared/value.ts'\n`,
      files: {
        'src/shared/value.ts': `export { other } from './other.ts'\n`,
        'src/shared/other.ts': `export const other: string = 'other'\n`,
        'src/cli.ts': `export const cli: string = 'cli'\n`,
      },
    })
  }
  dirs.flags = await fixture('.temp-cli/flags', { config: `export default {\n  sourcemap: true,\n  plugins: [builder()],\n}\n`, pkg: ({ typesVersions: _, ...pkg }) => pkg })

  const failing = {
    builderHooks: `export default {\n  plugins: [builder({ hooks: { 'build:before': () => {} } })],\n}\n`,
    configCwd: `export default {\n  cwd: './elsewhere',\n  plugins: [builder()],\n}\n`,
    configEnum: `enum Mode { Build }\nexport default {\n  define: { __MODE__: String(Mode.Build) },\n  plugins: [builder()],\n}\n`,
    withoutPlugin: `export default {}\n`,
    entriesOnly: `export default [{ entry: { utils: 'src/utils.ts' }, dts: false }]\n`,
    withoutTsdown: `export default {\n  plugins: [builder({ entries: [{ input: './src/utils', name: 'helpers' }] })],\n}\n`,
  }
  for (const [name, config] of Object.entries(failing)) {
    dirs[name] = await fixture(`.temp-cli/${name}`, { config })
  }
  await writeFile(join(dirs.withoutTsdown, 'no-tsdown.mjs'), `import { registerHooks } from 'node:module'\n\nregisterHooks({\n  resolve(specifier, context, nextResolve) {\n    if (/^(?:tsdown|rolldown)(?:\\/|$)/.test(specifier)) {\n      throw Object.assign(new Error(\`Cannot find package '\${specifier}'\`), { code: 'ERR_MODULE_NOT_FOUND' })\n    }\n    return nextResolve(specifier, context)\n  },\n})\n`)

  dirs.starExports = await fixture('.temp-cli/star-exports', {
    config: `export default {\n  plugins: [builder()],\n}\n`,
    module: `import { defineNuxtModule } from '@nuxt/kit'\nimport type { ModuleOptions } from './types/index.ts'\n\nexport * from './types/index.ts'\nexport type * from './types/runtime.ts'\n\nexport default defineNuxtModule<ModuleOptions>({\n  meta: { name: 'my-module', configKey: 'myModule' },\n  defaults: { apiKey: '' },\n})\n`,
    files: {
      'src/types/index.ts': `export * from './hooks.ts'\n\nexport interface ModuleOptions {\n  apiKey: string\n}\n`,
      'src/types/hooks.ts': `export interface ModuleHooks {\n  'my-module:init': () => void\n}\n`,
      'src/types/runtime.ts': `export interface ModuleRuntimeHooks {\n  'my-module:runtime-hook': () => void\n}\n\nexport interface ModulePublicRuntimeConfig {\n  NAME: string\n}\n`,
      ...Object.fromEntries(['.nuxt/module-builder/types.mjs', 'dist/types.mjs'].flatMap((types, index) => [
        [`probe-${index}.ts`, `import type {} from './${types}'\nimport type { RuntimeNuxtHooks } from '#app'\nimport type { NuxtHooks, PublicRuntimeConfig } from '@nuxt/schema'\n\nexport type Augmented = [NuxtHooks['my-module:init'], RuntimeNuxtHooks['my-module:runtime-hook'], PublicRuntimeConfig['NAME']]\n`],
        [`probe-${index}.tsconfig.json`, JSON.stringify({ extends: './.nuxt/tsconfig.json', compilerOptions: { noEmit: true, skipLibCheck: types.startsWith('.nuxt') }, include: [], files: [`probe-${index}.ts`] })],
      ])),
    },
  })

  const selfListed = (pkg: PackageJson) => ({ ...pkg, name: 'self-listed-module' })
  const selfListedFiles = {
    '.nuxtrc': (source: string) => `${source}\nmodules[]=self-listed-module\n`,
    'nuxt.config.ts': `export default { modules: [['self-listed-module', { apiKey: 'from-config' }]] }\n`,
  }
  const logOptions = (source: string) => source.replace('setup(_options, _nuxt) {', 'setup(_options, _nuxt) {\n    console.log(`[setup] ${_options.apiKey}`)')
  dirs.selfListedDist = await fixture('.temp-cli/self-listed-dist', { remove: ['.nuxt'], pkg: selfListed, module: logOptions, files: selfListedFiles })
  dirs.selfListedSource = await fixture('.temp-cli/self-listed-source', { remove: ['.nuxt'], pkg: pkg => ({ ...selfListed(pkg), exports: { '.': './src/module.ts' }, main: './src/module.ts' }), module: logOptions, files: selfListedFiles })

  const addTypeTemplate = (source: string, extra = '') => source
    .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addTypeTemplate, createResolver } from \'@nuxt/kit\'')
    .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', `    addPlugin(resolver.resolve('./runtime/plugins/plugin'))\n    addTypeTemplate({ filename: 'types/my-module.d.ts', getContents: () => 'import type { ModuleOptions } from "my-module"\\ndeclare module "#app" {\\n  interface NuxtApp {\\n    $myModuleOptions: ModuleOptions\\n  }\\n}\\nexport {}\\n' })\n    const configured: unknown = _nuxt.options.myModule\n    void configured${extra}`)

  dirs.ownPackage = await fixture('.temp-cli/own-package', {
    config: 'export default { plugins: [builder()] }\n',
    remove: ['.nuxt'],
    pkg: pkg => ({ ...pkg, exports: examplePkg.exports, main: examplePkg.main, types: examplePkg.types, publishConfig: examplePkg.publishConfig, imports: { '#my-helpers': './src/helpers.ts' } }),
    module: source => addTypeTemplate(source, [
      '',
      `    const strip = (options?: object): void => { if (options) Reflect.deleteProperty(options, 'allowImportingTsExtensions') }`,
      `    _nuxt.hook('prepare:types', ({ tsConfig, nodeTsConfig, sharedTsConfig, serverTsConfig }) => [tsConfig, nodeTsConfig, sharedTsConfig, serverTsConfig].forEach(config => strip(config?.compilerOptions)))`,
      `    _nuxt.hook('nitro:init', (nitro) => { nitro.hooks.hook('types:extend', ({ tsConfig }) => strip(tsConfig?.compilerOptions)) })`,
    ].join('\n')).replace(`createResolver } from '@nuxt/kit'`, `createResolver } from '@nuxt/kit'\n\nexport type { Helper } from '#my-helpers'\nexport type { Extra } from './extra'`),
    files: {
      'tsconfig.json': source => JSON.stringify({ extends: './tsconfig.options.json', ...JSON.parse(source), exclude: undefined }),
      'tsconfig.options.json': JSON.stringify({ compilerOptions: { types: ['vitest/importMeta'] }, exclude: ['dist', 'node_modules', 'playground'] }),
      'src/helpers.ts': `export interface Helper {\n  name: string\n}\n`,
      'src/extra.d.ts': `export interface Extra {\n  id: string\n}\n`,
      'shared/options.ts': `import type { Extra, ModuleOptions } from 'my-module'\n\nexport const sharedApiKey = (options: ModuleOptions, extra: Extra): string => options.apiKey + extra.id\n// @ts-expect-error a string is not a number\nexport const extraId = (extra: Extra): number => extra.id\n`,
      'src/runtime/composables/useUtils.ts': `import { myModuleUtils } from 'my-module/utils'\n\nexport const useUtils = (): () => void => myModuleUtils\n`,
      'src/runtime/server/options.ts': `import type { ModuleOptions } from 'my-module'\n\nexport const apiKey = (options: ModuleOptions): string => options.apiKey\n`,
    },
  })

  dirs.ownPackageIsolated = await fixture('.temp-cli/own-package-isolated', {
    config: 'export default { plugins: [builder()] }\n',
    remove: ['.nuxt'],
    pkg: pkg => ({ ...pkg, imports: { '#payload': './src/nested/payload.ts' } }),
    module: [
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
    ].join('\n'),
    files: {
      'src/nested/payload.ts': `export interface Payload {\n  value: string\n}\n`,
      'src/nested/shape.ts': `export interface Shape {\n  sides: number\n}\n`,
      'src/utils.ts': `export const myModuleUtils = (): void => {}\n`,
      'src/runtime/composables/usePayload.ts': `import type { ModuleOptions } from 'my-module'\n\nexport const usePayload = (options: ModuleOptions): string | undefined => options.payload?.value\n`,
      'tsconfig.module.json': JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { isolatedDeclarations: true, declaration: true, allowJs: false } }),
      'tsconfig.json': REFERENCES('./tsconfig.module.json'),
    },
  })

  dirs.ownPackageError = await fixture('.temp-cli/own-package-error', {
    config: 'export default { plugins: [builder()] }\n',
    module: source => `export type Logger = typeof import('./logger.ts').logger\nexport type Styles = typeof import('./styles.ts').styles\n${source}`,
    files: {
      [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
      'src/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n`,
      'src/unused.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const unused = createModuleLogger('unused')\n`,
      [`${store('fake-format')}/package.json`]: JSON.stringify({ name: 'fake-format', type: 'module', exports: { '.': { types: './index.d.ts' } } }),
      [`${store('fake-format')}/index.d.ts`]: `export interface Format { bold: boolean }\nexport declare function createFormat(): Format\n`,
      [`${store('fake-styles')}/package.json`]: JSON.stringify({ name: 'fake-styles', type: 'module', exports: { '.': { types: './index.d.ts' } } }),
      [`${store('fake-styles')}/index.d.ts`]: `import { createFormat } from 'fake-format'\nexport declare function createStyles(): ReturnType<typeof createFormat>\n`,
      'src/styles.ts': `import { createStyles } from 'fake-styles'\n\nexport const styles = createStyles()\n`,
      'src/runtime/server/format.ts': `import { createFormat } from 'fake-format'\n\nexport const format = createFormat()\n`,
      'tsconfig.json': REFERENCES('./.nuxt/tsconfig.node.json'),
    },
    links: {
      'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger': store('fake-logger'),
      'node_modules/fake-shared': store('fake-shared'),
      'node_modules/.pnpm/fake-styles@1.0.0/node_modules/fake-format': store('fake-format'),
      'node_modules/fake-format': store('fake-format'),
      'node_modules/fake-styles': store('fake-styles'),
    },
  })

  dirs.unchecked = await fixture('.temp-cli/unchecked', {
    remove: ['tsdown.config.ts'],
    files: {
      'tsdown.config.mjs': `${builderImport}\nexport default { plugins: [builder()] }\n`,
      'eslint.config.ts': `export default []\n`,
      'tsconfig.json': source => JSON.stringify({ ...JSON.parse(source), exclude: ['dist', 'node_modules', 'playground', 'scripts'] }),
      'test/unit.ts': `import { helper } from './utils.ts'\n\nexport const result: string = helper()\n`,
      'test/utils.ts': `export const helper = (): string => 'helper'\n// @ts-expect-error a string is not a number\nexport const count: number = 'one'\n`,
      'test/nuxt/app.ts': `export const app: string = 'app'\n`,
      'test/fixtures/basic/nuxt.config.ts': `export default defineNuxtConfig({ modules: ['../../../src/module'] })\n`,
      'test/fixtures/basic/app.vue': `<script setup lang="ts">\nconst count = ref(1)\n</script>\n\n<template>\n  <div>{{ count }}</div>\n</template>\n`,
      'vitest.config.ts': `export default {}\n`,
      'prettier.config.mjs': `export default {}\n`,
      'scripts/release.ts': `export {}\n`,
      'src/helpers/format.ts': `export const format = (value: string): string => value\n`,
      'test/globals.d.ts': `declare const __TEST__: boolean\n`,
      'docs/example.ts': `export {}\n`,
      'playground/extra.ts': `export {}\n`,
    },
  })

  dirs.nitroDir = await fixture('.temp-cli/nitro-dir', {
    remove: ['src/runtime/components'],
    files: {
      'src/kit/gen.ts': `import type { Helper } from './helper.ts'\nimport { helper } from './helper.ts'\n\nexport const gen = (): Helper => helper()\n`,
      'src/kit/helper.ts': `export type Helper = string\nexport const helper = (): Helper => 'helper'\n`,
      'src/runtime/composables/useGen.ts': `import type { gen } from '../../kit/gen.ts'\n\nexport const useGen = (): ReturnType<typeof gen> => 'gen'\n`,
      'src/runtime/nitro/plugin.ts': `export const title = (): string => document.title\n`,
      'tsconfig.nitro.json': JSON.stringify({
        extends: './.nuxt/tsconfig.server.json',
        compilerOptions: { tsBuildInfoFile: './.nuxt/tsconfig.nitro.tsbuildinfo' },
        include: ['./.nuxt/types/nitro-nuxt.d.ts', './.nuxt/types/nitro.d.ts', './src/runtime/nitro'],
      }),
      'tsconfig.json': (source) => {
        const tsconfig = JSON.parse(source)
        return JSON.stringify({ ...tsconfig, exclude: [...tsconfig.exclude, 'src/runtime/nitro'], references: [...tsconfig.references, { path: './tsconfig.nitro.json' }] })
      },
    },
  })

  dirs.noTsconfig = await fixture('.temp-cli/monorepo/mod', {
    from,
    remove: ['tsconfig.json'],
    files: { '../tsconfig.json': JSON.stringify({ extends: './.nuxt/tsconfig.json' }) },
  })

  dirs.legacyPrepare = await fixture('.temp-cli/legacy-prepare', {
    config: 'export default { plugins: [builder()] }\n',
    remove: ['.nuxt'],
    module: source => addTypeTemplate(source, `\n    void _nuxt.callHook('my-module:init', 'shared-type')`),
    files: {
      'src/runtime/server/options.ts': `export const apiKey = (options: { apiKey: string }): string => options.apiKey\n`,
      'tsconfig.json': JSON.stringify({ extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground', 'tsdown.config.ts', 'nuxt.config.ts'] }),
      'nuxt.config.ts': `export default { buildDir: '.nuxt-custom' }\n`,
    },
  })

  dirs.source = await fixture('.temp-cli/source', {
    config: `export default {\n  publint: true,\n  plugins: [builder({ entries: ['./src/utils'] })],\n}\n`,
    remove: ['.nuxt', 'playground/.nuxt', 'playground/.output'],
    pkg: ({ typesVersions: _, ...pkg }) => ({
      ...pkg,
      exports: { '.': { types: './.nuxt/module-builder/types.d.mts', default: './src/module.ts' }, './utils': './src/utils.ts' },
      main: './src/module.ts',
      types: './.nuxt/module-builder/types.d.mts',
      scripts: { prepack: `node ${JSON.stringify(cliBin)} build` },
      publishConfig: {
        exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' }, './utils': { types: './dist/utils.d.mts', default: './dist/utils.mjs' } },
        main: './dist/module.mjs',
        types: './dist/types.d.mts',
        typesVersions: { '*': { utils: ['./dist/utils.d.mts'] } },
      },
    }),
    module: source => source.replace(`import type { SharedTypeFromRuntime } from './runtime/plugins/plugin'`, `type SharedTypeFromRuntime = 'shared-type'`),
  })

  dirs.dist = await fixture('.temp-cli/dist', {
    remove: ['.nuxt', 'playground/.nuxt'],
    pkg: pkg => ({ ...pkg, scripts: { prepack: `node ${JSON.stringify(tsdownBin)}` } }),
  })

  const nuxt = (args: string[], cwd = repoRoot) => run('node', [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), ...args], { cwd })
  const typecheck = (dir: string, context: string) => run(bin('vue-tsc'), ['--noEmit', '-p', join(dir, `playground/.nuxt/tsconfig.${context}.json`)], { cwd: dir })
  const consumerCheck = (dir: string) => run(bin('tsc'), ['--noEmit', '-p', join(dir, 'playground/consumer.tsconfig.json')])
  const listed = (dir: string, project: string) => run(bin('vue-tsc'), ['-p', project, '--noEmit', '--listFilesOnly'], { cwd: dir })
  const pack = (dir: string, command: string) => mkdir(join(dir, '.pack')).then(() => run(command, ['pack', '--pack-destination', join(dir, '.pack')], { cwd: dir }))

  await Promise.all([
    step('runtime', cli(['build', dirs.runtimeLink])),
    step('isolated', cli(['build', dirs.isolated])).then(() => step('isolated:consumer', consumerCheck(dirs.isolated))),
    step('types', cli(['build', dirs.types])).then(() => step('types:consumer', consumerCheck(dirs.types))),
    step('minimal', cli(['build', dirs.minimal])),
    step('minimal:outDir', cli(['build', '--outDir', '..', dirs.minimal])),
    step('minimal:stub', cli(['build', '--stub', dirs.minimal])),
    step('minimal:prepare-stub', cli(['prepare', '--stub', dirs.minimal])),
    step('shape', cli(['build', dirs.shape])),
    step('loader:prepare', cli(['prepare', dirs.loader])).then(() => Promise.all([
      step('loader', cli(['build', dirs.loader])),
      step('loader:probe', run(bin('tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--allowImportingTsExtensions', '--module', 'nodenext', '--moduleResolution', 'nodenext', join(dirs.loader, 'probe.ts')])),
    ])),
    step('unloadable', cli(['build', dirs.unloadable])),
    step('unloadable:prepare', cli(['prepare', dirs.unloadable])),
    step('unloadableDist', cli(['build', dirs.unloadableDist])),
    step('isolatedError', cli(['build', dirs.isolatedError])),
    step('typeError', cli(['build', dirs.typeError])),
    step('vueError', cli(['build', dirs.vueError])),
    step('solution', cli(['build', dirs.solution])),
    step('referencedSource', cli(['build', dirs.referencedSource])),
    step('parent', cli(['build', dirs.parent])),
    inOrder(['routes:prepare', () => cli(['prepare', dirs.routes!])], ['routes:playground', () => nuxt(['prepare', join(dirs.routes!, 'playground')])], ['routes', () => cli(['build', dirs.routes!])]),
    ...['object', 'array', 'function'].map(shape => step(`${shape}:prepare`, cli(['prepare', dirs[shape]!])).then(() => step(shape, cli(['build', dirs[shape]!])))),
    step('flags', cli(['build', '--outDir', 'custom', '--no-sourcemap', dirs.flags])),
    step('builderHooks', cli(['build', dirs.builderHooks!])),
    step('builderHooks:prepare', cli(['prepare', dirs.builderHooks!])),
    step('configCwd', cli(['prepare', dirs.configCwd!]))
      .then(() => writeFile(join(dirs.configCwd!, 'tsdown.config.ts'), `${builderImport}\nexport default {\n  cwd: '.',\n  plugins: [builder()],\n}\n`))
      .then(() => step('configCwd:fixed', cli(['prepare', dirs.configCwd!]))),
    step('configEnum', cli(['build', dirs.configEnum!])),
    step('configEnum:prepare', cli(['prepare', dirs.configEnum!])),
    step('withoutPlugin', cli(['build', dirs.withoutPlugin!])),
    step('withoutPlugin:prepare', cli(['prepare', dirs.withoutPlugin!])),
    step('entriesOnly', cli(['build', dirs.entriesOnly!])),
    step('withoutTsdown:root', run('node', ['--import', pathToFileURL(join(dirs.withoutTsdown!, 'no-tsdown.mjs')).href, '--input-type=module', '-e', `await import('tsdown').then(() => console.log('tsdown found'), () => {})\nconst root = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'src/index.ts')).href)})\nconsole.log(Object.keys(root).sort().join(','))`], { cwd: dirs.withoutTsdown })),
    step('withoutTsdown', run('node', ['--import', pathToFileURL(join(dirs.withoutTsdown!, 'no-tsdown.mjs')).href, cliBin, 'build', dirs.withoutTsdown!], { cwd: dirs.withoutTsdown })),
    step('starExports:prepare', cli(['prepare', dirs.starExports])).then(() => step('starExports', cli(['build', dirs.starExports]))).then(() => Promise.all([0, 1].map(index =>
      step(`starExports:probe-${index}`, run(bin('tsc'), ['-p', `probe-${index}.tsconfig.json`], { cwd: dirs.starExports })),
    ))),
    step('selfListedDist', cli(['build', dirs.selfListedDist])),
    step('selfListedSource', cli(['prepare', dirs.selfListedSource])),
    step('ownPackage', cli(['prepare', dirs.ownPackage])).then(() => Promise.all([
      step('ownPackage:typecheck', run(bin('vue-tsc'), ['-b', '--noEmit'], { cwd: dirs.ownPackage })),
      ...['app', 'server', 'shared'].map(name => step(`ownPackage:${name}`, listed(dirs.ownPackage!, `.nuxt/tsconfig.${name}.json`))),
    ])),
    step('ownPackageIsolated', cli(['prepare', dirs.ownPackageIsolated])).then(() => Promise.all([
      step('ownPackageIsolated:typecheck', run(bin('vue-tsc'), ['-b', '--noEmit'], { cwd: dirs.ownPackageIsolated })),
      step('ownPackageIsolated:app', listed(dirs.ownPackageIsolated!, '.nuxt/tsconfig.app.json')),
    ])),
    step('ownPackageError', cli(['prepare', dirs.ownPackageError])),
    inOrder(
      ['nitroDir:prepare', () => cli(['prepare', dirs.nitroDir!])],
      ['nitroDir', () => cli(['build', dirs.nitroDir!])],
      ['nitroDir:typecheck', () => run(bin('vue-tsc'), ['-b', '--noEmit'], { cwd: dirs.nitroDir })],
    ),
    inOrder(
      ['unchecked:ci', () => cli(['prepare', dirs.unchecked!], { CI: '1' })],
      ['unchecked', () => cli(['prepare', dirs.unchecked!], { CI: '' })],
    ).then(async (ran) => {
      if (!ran) {
        return
      }
      const tsconfig = JSON.parse(await read(dirs.unchecked!, 'tsconfig.json'))
      await writeFile(join(dirs.unchecked!, 'tsconfig.json'), JSON.stringify({ ...tsconfig, references: [...tsconfig.references, { path: './tsconfig.test.json' }] }))
      await writeFile(join(dirs.unchecked!, 'tsconfig.test.json'), JSON.stringify(TEST_TSCONFIG))
      await inOrder(
        ['unchecked:test', () => cli(['prepare', dirs.unchecked!], { CI: '' })],
        ['unchecked:typecheck', () => run(bin('vue-tsc'), ['-b', '--noEmit'], { cwd: dirs.unchecked })],
        ['unchecked:files', () => listed(dirs.unchecked!, 'tsconfig.test.json')],
      )
    }),
    step('noTsconfig', cli(['prepare', dirs.noTsconfig])),
    step('legacyPrepare', cli(['prepare', dirs.legacyPrepare])).then(() => Promise.all([
      step('legacyPrepare:typecheck', run(bin('vue-tsc'), ['--noEmit'], { cwd: dirs.legacyPrepare })),
      step('legacyPrepare:files', run(bin('vue-tsc'), ['--noEmit', '--listFilesOnly'], { cwd: dirs.legacyPrepare })),
    ])),
    (async () => {
      if (!await inOrder(['source:prepare', () => cli(['prepare', dirs.source!])], ['source:playground', () => nuxt(['prepare', 'playground'], dirs.source)])) {
        return
      }
      await Promise.all([
        step('source:app', typecheck(dirs.source!, 'app')),
        step('source:node', typecheck(dirs.source!, 'node')),
        step('source:npm', run('node', [...packProbeArgs, cliBin, 'build'], { cwd: dirs.source, env: npmPackFromPnpmScript() })),
      ])
      sourceWithoutDist = !exists(dirs.source!, 'dist')
      await Promise.all([
        step('source:generate', nuxt(['generate', 'playground'], dirs.source)),
        inOrder(['source:pack', () => pack(dirs.source!, 'pnpm')], ['source:attw', () => run(bin('attw'), [join(dirs.source!, '.pack/my-module-1.0.0.tgz'), '--ignore-rules', 'cjs-resolves-to-esm'], { cwd: dirs.source })]),
      ])
    })(),
    (async () => {
      if (!await inOrder(['dist:prepare', () => cli(['prepare', dirs.dist!])], ['dist:build', () => run('node', [tsdownBin], { cwd: dirs.dist })], ['dist:playground', () => nuxt(['prepare', 'playground'], dirs.dist)])) {
        return
      }
      await Promise.all([step('dist:app', typecheck(dirs.dist!, 'app')), step('dist:node', typecheck(dirs.dist!, 'node'))])
      await inOrder(['dist:generate', () => nuxt(['generate', 'playground'], dirs.dist)], ['dist:pack', () => pack(dirs.dist!, 'npm')])
    })(),
  ])
})

const expectBuilt = (name: string) => {
  const { exitCode, output } = result(name)
  expect(exitCode, output).toBe(0)
  return output
}

const expectFailed = (name: string) => {
  const { exitCode, output } = result(name)
  expect(exitCode, output).not.toBe(0)
  return output
}

describe('a module that imports runtime code, built through a symlink, under a path with spaces and non-ASCII characters', () => {
  const dist = () => join(dirs.runtime!, 'dist')

  it('should generate module metadata', async () => {
    expectBuilt('runtime')
    expect(JSON.parse(await read(dist(), 'module.json'))).toMatchObject({ configKey: 'myModule', name: 'my-module' })
  })

  it('should externalise runtime imports made through relative, aliased and `.vue` specifiers', async () => {
    expect(runtimeSpecifiers(await read(dist(), 'module.mjs'))).toEqual([
      './runtime/composables/useShape.js',
      './runtime/utils/aliased.js',
      './runtime/utils/name.js',
    ])
    const moduleDts = await read(dist(), 'module.d.mts')
    expect(staticImports(moduleDts).find(i => i.specifier.includes('plugins'))!.code).toBe(`import { SharedTypeFromRuntime } from "./runtime/plugins/plugin.js";`)
    expect(staticImports(moduleDts).map(i => i.specifier)).toContain('./runtime/components/JsxComponent.jsx')
    expect(moduleDts).toContain('from "nuxt/app"')
    expect(moduleDts).not.toContain('#app')
  })

  it('should point imports of a runtime JSX file at its `.jsx` output', async () => {
    expect(await read(dist(), 'runtime/components/JsxCard.vue')).toContain(`import JsxComponent from "./JsxComponent.jsx";`)
    expect(await read(dist(), 'runtime/components/JsxSlot.jsx')).toMatchInlineSnapshot(`
      "import { defineComponent } from "vue";
      import { useNuxtApp } from "#app";
      import JsxComponent from "./JsxComponent.jsx";
      export const useSlotApp = () => useNuxtApp();
      export default defineComponent((_, { slots }) => () => <section><JsxComponent />{slots.default?.()}</section>);
      "
    `)
    expect(await read(dist(), 'runtime/components/JsxSlot.d.ts')).toContain('export declare const useSlotApp: () => import("nuxt/app").NuxtApp;')
  })

  it('should compile JSX in server runtime files and the files they import, and preserve it elsewhere', async () => {
    expect(exists(dist(), 'runtime/server/render.jsx')).toBe(false)
    for (const file of ['utils/strong.js', 'utils/bold.js']) {
      expect(await read(dist(), 'runtime', file), file).toContain(`import { jsx as _jsx } from "vue/jsx-runtime";`)
    }
    expect(await read(dist(), 'runtime/utils/label.jsx')).toContain('<span>label</span>')
    expect(await read(dist(), 'runtime/server/render.js')).toMatchInlineSnapshot(`
      "import { strong } from "../utils/strong.js";
      import { jsx as _jsx } from "vue/jsx-runtime";
      export const render = (label) => /* @__PURE__ */ _jsx("p", { children: strong(label) });
      "
    `)
    expect(await read(dist(), 'runtime/server/render.d.ts')).toMatchInlineSnapshot(`
      "import { useSlotApp } from '../components/JsxSlot.jsx';
      export type SlotApp = ReturnType<typeof useSlotApp>;
      export declare const render: (label: string) => import("vue/jsx-runtime").JSX.Element;
      "
    `)
  })

  it('should keep every non-relative runtime import as written', async () => {
    expect(staticImports(await read(dist(), 'runtime/server/handler.js')).map(i => i.specifier)).toEqual([
      '#internal/nuxt.config.mjs',
      '~/app.config',
      '@/root',
      '#app',
      'fake-dep',
      '#fixture-cache',
      '../utils/local.js',
    ])
    expect(staticImports(await read(dist(), 'runtime/utils/options.d.ts')).map(i => i.specifier)).toEqual(['fake-types'])
  })

  it('should not emit dependencies or bundler helpers into the runtime directory', async () => {
    const files = await listFiles(join(dist(), 'runtime'))
    expect(files.filter(file => /node_modules|_virtual/.test(file))).toEqual([])
    for (const file of files.filter(file => /\.m?[jt]s$/.test(file))) {
      expect(await read(dist(), 'runtime', file), file).not.toMatch(/bundled-fake-dep|DeepPartial<T\[K\]>/)
    }
  })

  it('should keep types of packages that are not dependencies external in module declarations', async () => {
    const types = await read(dist(), 'module.d.mts')
    expect(types).toMatch(/from "fake-types"/)
    expect(types).toMatch(/from "fake-cjs-types"/)
    expect(types).not.toMatch(/DeepPartial<T\[K\]>/)
  })

  it('should name inferred types by package when the generated tsconfig maps a package to its real path', async () => {
    const types = await read(dist(), 'module.d.mts')
    expect(types).toMatch(/Thing<\{/)
    expect(types).toMatch(/["']fake-schema["']/)
  })

  it('should keep bracketed file names in runtime output', () => {
    expect(exists(dist(), 'runtime/server/routes/[...slug].js')).toBe(true)
    expect(exists(dist(), 'runtime/server/routes/[...slug].d.ts')).toBe(true)
  })

  it('should resolve imports of the package itself to its source in declarations', async () => {
    expect(await read(dist(), 'runtime/utils/self.d.ts')).toMatch(/=> string;/)
  })

  it('should warn about type errors that do not affect runtime declarations and build anyway', async () => {
    const output = expectBuilt('runtime')
    expect(output).toMatch(/^\[NUXT_MB_B0201\] 2 type errors were reported while generating declarations for `src\/runtime`; the declarations were emitted\.$/m)
    expect(output).toContain('fix: Run the module\'s own type check, `vue-tsc --noEmit`, and fix the errors that it reports.')
    expect(output).toContain('src/runtime/utils/typo.ts(1,14): error TS2322')
    expect(output).toContain('src/runtime/components/Typo.vue(3,7): error TS2322')
    expect(output.match(/type errors? (?:was|were) reported/g)).toHaveLength(1)
    expect(output).not.toContain('TS2307')
    expect(await read(dist(), 'runtime/utils/typo.d.ts')).toBe('export declare const count: number;\nexport declare const double: (value: number) => number;\n')
    const component = await read(dist(), 'runtime/components/Typo.vue.d.ts')
    expect(component).toContain('label: string')
    expect(component).toBe(await read(dist(), 'runtime/components/Typo.d.vue.ts'))
    const composable = await read(dist(), 'runtime/composables/useSize.d.ts')
    expect(composable).toContain(`import type { Props } from '../components/Sized.vue';`)
    expect(composable).toMatch(/export declare function useSize\(props: Props\): import\("vue"\)\.ComputedRef<"xs" \| "sm" \| "md" \| undefined>;/)
  })

  it('should give every relative specifier in runtime declarations an extension that resolves', async () => {
    expect(await unresolvedSpecifiers(dist())).toEqual([])
  })
})

describe('a module with `isolatedDeclarations` and no `.nuxt`', () => {
  const dist = () => join(dirs.isolated!, 'dist')

  it('should prepare the module before building it', async () => {
    expect(expectBuilt('isolated')).toContain('[NUXT_MB_B0101]')
    expect(await read(dist(), 'runtime/composables/useAliasedApp.d.ts')).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
  })

  it('should build an annotated module while still inferring runtime types', async () => {
    const moduleTypes = await read(dist(), 'module.d.mts')
    expect(moduleTypes).toContain('NuxtModule<ModuleOptions>')
    expect(moduleTypes).toMatch(/apiKey: string/)
    expect(await read(dist(), 'runtime/plugins/plugin.d.ts')).toContain('import("nuxt/app").Plugin<')
    expect(JSON.parse(await read(dist(), 'module.json'))).toMatchObject({ name: 'my-module', configKey: 'myModule' })
  })

  it('should keep value exports as values in `types.d.mts`', async () => {
    expect(await read(dist(), 'types.d.mts')).toMatchInlineSnapshot(`
      "import type { ModuleHooks, ModuleRuntimeHooks, ModuleRuntimeConfig, ModulePublicRuntimeConfig } from './module.mjs'

      declare module '#app' {
        interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}
      }

      declare module '@nuxt/schema' {
        interface NuxtHooks extends ModuleHooks {}
        interface RuntimeConfig extends ModuleRuntimeConfig {}
        interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}
      }

      export { defineMyModuleConfig, Mode, type ModuleHooks, type ModuleOptions, type ModulePublicRuntimeConfig, type ModuleRuntimeConfig, type ModuleRuntimeHooks, myModuleVersion, default } from './module.mjs'
      "
    `)
    expect(expectBuilt('isolated:consumer')).toBe('')
  })

  it('should flatten, prefix and minify runtime CSS', async () => {
    const card = await read(dist(), 'runtime/styles/card.css')
    expect(card).toMatch(/^@import "\.\/base\.css";/)
    expect(card).toContain('.card .title{font-weight:700}')
    expect(card).toContain('.card:hover{color:#639}')
    expect(card).toContain('-webkit-user-select:none')
    expect(card).not.toMatch(/&|\n/)
  })

  it('should compile runtime Sass to CSS and skip partials', async () => {
    const styles = join(dist(), 'runtime/styles')
    expect(await listFiles(styles)).toEqual(['base.css', 'card.css', 'indented.css', 'legacy.less', 'theme.css'])
    expect(await read(styles, 'theme.css')).toMatch(/^\.theme \.nested \{\s*padding: 1px;\s*\}$/m)
    expect(await read(styles, 'theme.css')).toContain('color: #00dc82;')
    expect(await read(styles, 'indented.css')).toContain('color: blue;')
  })

  it('should copy runtime declaration files verbatim, apart from `#app`', async () => {
    expect(await read(dist(), 'runtime/types/ambient.d.ts')).toBe(await read(dirs.isolated!, 'src/runtime/types/ambient.d.ts'))
    expect(await read(dist(), 'runtime/types/app.d.ts')).toBe(`import type { NuxtApp } from 'nuxt/app'\nexport type App = NuxtApp\n`)
  })

  it('should point stylesheet imports in runtime scripts at the emitted files', async () => {
    const styled = await read(dist(), 'runtime/plugins/styled.js')
    expect(styled).toContain('import "../styles/card.css";')
    expect(styled).toContain('import "../styles/theme.css";')
    expect(styled).not.toContain('theme.scss')
  })
})

describe('a module without exported `ModuleOptions`', () => {
  it('should generate types that infer them and keep value exports as values', async () => {
    expectBuilt('types')
    expect(await read(dirs.types!, 'dist/types.d.mts')).toMatchInlineSnapshot(`
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

      export { defineMyModuleConfig, Mode, type ModuleHooks, type ModulePublicRuntimeConfig, type ModuleRuntimeConfig, type ModuleRuntimeHooks, myModuleVersion, default } from './module.mjs'
      "
    `)
    expect(expectBuilt('types:consumer')).toBe('')
  })
})

describe('a module without a runtime directory', () => {
  it('should build its entries and a directory that contains only single-file components', async () => {
    expectBuilt('minimal')
    expect(await listFiles(join(dirs.minimal!, 'dist'))).toMatchInlineSnapshot(`
      [
        "components",
        "components/TestMe.css",
        "components/TestMe.d.vue.ts",
        "components/TestMe.vue",
        "components/TestMe.vue.d.ts",
        "components/TestMeSetup.d.vue.ts",
        "components/TestMeSetup.vue",
        "components/TestMeSetup.vue.d.ts",
        "module.d.mts",
        "module.json",
        "module.mjs",
        "types.d.mts",
        "utils.d.mts",
        "utils.mjs",
      ]
    `)
  })

  it('should refuse an `outDir` outside the module root', () => {
    expect(expectFailed('minimal:outDir')).toContain(`[NUXT_MB_C0012] \`--outDir ..\` resolves to \`${resolve(dirs.minimal!, '..')}\``)
    expect(exists(dirs.minimal!, 'package.json')).toBe(true)
  })

  it('should fail on `--stub` and point at what replaces it', () => {
    for (const command of ['build', 'prepare']) {
      expect(expectFailed(command === 'build' ? 'minimal:stub' : 'minimal:prepare-stub'), command).toContain(`[NUXT_MB_D0001] The \`--stub\` option of \`${command}\` has been removed.`)
    }
  })
})

describe('a module whose runtime files import files around them', () => {
  const dist = () => join(dirs.shape!, 'dist')

  it('should keep the imports and re-exports of each runtime file as written, in source order', async () => {
    expectBuilt('shape')
    const runtime = join(dist(), 'runtime')
    expect(await read(runtime, 'disabled/index.js')).toMatchInlineSnapshot(`
      "import "./side.js";
      export { defineThing } from "./composables/defineThing.js";
      "
    `)
    expect(await read(runtime, 'disabled/composables/defineThing.js')).toMatchInlineSnapshot(`
      "export { defineThing } from "../../composables/mock.js";
      "
    `)
    expect(await read(runtime, 'content/index.js')).toMatchInlineSnapshot(`
      "export * from "../components/TestMe.vue";
      export * from "../components/TestMeSetup.vue";
      export * from "./prose.js";
      "
    `)
    expect(await read(runtime, 'content/index.d.ts')).toMatchInlineSnapshot(`
      "export * from '../components/TestMe.vue';
      export * from '../components/TestMeSetup.vue';
      export * from './prose.js';
      "
    `)
    expect(await read(runtime, 'content/prose.d.ts')).toMatchInlineSnapshot(`
      "export * from './levels.js';
      export interface ProseThing {
          title: string;
      }
      "
    `)
    expect(await read(runtime, 'order/interleaved.js')).toMatchInlineSnapshot(`
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
    expect(await read(dist(), 'runtime/server/uses.js')).toMatchInlineSnapshot(`
      "import { merge } from "../../utils/merge.mjs";
      import { CONSTANT } from "../../shared/constants.js";
      export const combine = (a, b) => [merge(a, b), CONSTANT];
      "
    `)
    expect(await read(dist(), 'runtime/server/uses.d.ts')).toMatchInlineSnapshot(`
      "import type { RootType } from '../../_external/src/types.js';
      import type { RuntimeType } from '../types.js';
      export declare const combine: (a: RootType & RuntimeType, b: RootType & RuntimeType) => readonly [RootType & RuntimeType, 10];
      "
    `)
    expect(await read(dist(), 'runtime/escaping.js')).toContain(`import("../_external/external.js")`)
    expect(await read(dist(), 'shared/constants.js')).toMatchInlineSnapshot(`
      "import { LIMIT } from "./limits.js";
      export const CONSTANT = LIMIT;
      "
    `)
    const files = await listFiles(dist())
    expect(files.filter(file => !file.startsWith('runtime'))).toMatchInlineSnapshot(`
      [
        "_external",
        "_external/external.d.ts",
        "_external/external.js",
        "_external/src",
        "_external/src/types.d.ts",
        "data.d.mts",
        "data.mjs",
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
    expect(files.filter(file => /^runtime\/(?:types|server|utils)/.test(file))).toMatchInlineSnapshot(`
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
    expect(await read(dist(), 'runtime/server/limiter.js')).toMatchInlineSnapshot(`
      "import "../disabled/side.js";
      export const limit = (options) => options.maxRequestSizeInBytes;
      "
    `)
    expect(await read(dist(), 'runtime/composables/useLocaleRoute.js')).toMatchInlineSnapshot(`
      "export const useLocaleRoute = (route) => route;
      "
    `)
    expect(await read(dist(), 'routing.d.ts')).toMatchInlineSnapshot(`
      "import type { RootType } from './_external/src/types.js';
      export interface RouteInfo {
          path: string;
          root: RootType;
      }
      export declare const localizeRoutes: (file: string) => string;
      "
    `)
    for (const file of ['routing.js', 'kit', 'types/middlewares.js', 'types.d.ts', 'types.js', '_external/src/types.js']) {
      expect(exists(dist(), file), file).toBe(false)
    }
  })

  it('should type imports of build-time aliases as `any` in declarations', async () => {
    const runtime = join(dist(), 'runtime')
    expect(await read(runtime, 'composables/useThemeConfig.d.ts')).toContain('useThemeConfig: () => any;')
    expect(await read(runtime, 'composables/useButton.d.ts')).toMatchInlineSnapshot(`
      "export declare const useButton: () => {
          slots: any;
          size: any;
          ui: any;
      };
      "
    `)
    expect(await read(runtime, 'components/Button.d.vue.ts')).toMatchInlineSnapshot(`
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
    expect(exists(runtime, 'components/Sized.vue.d.ts')).toBe(true)
  })

  it('should give every relative specifier in declarations an extension that resolves', async () => {
    expect(await unresolvedSpecifiers(dist())).toEqual([])
  })
})

describe('a module whose entry Node cannot import natively, with a wildcard `paths` entry', () => {
  it('should prepare it without handing it to jiti', async () => {
    expect(expectBuilt('loader:prepare')).not.toContain('ERR_INTERNAL_ASSERTION')
    expect(await read(dirs.loader!, '.nuxt/nuxt.node.d.ts')).toContain('/// <reference path="module-builder/types.d.mts" />')
    expect(await read(dirs.loader!, '.nuxt/types/modules.d.ts')).toContain(`typeof import(${JSON.stringify(join(dirs.loader!, 'src/module'))}).default`)
  })

  it('should re-export the module\'s default export from the types that `prepare` writes', () => {
    expect(expectBuilt('loader:probe')).toBe('')
  })

  it('should bundle the `imports` of `package.json` and the files they point at', async () => {
    expectBuilt('loader')
    const built = await read(dirs.loader!, 'dist/module.mjs')
    expect(built).toContain('loaded helper')
    expect(built).toContain('through imports')
    expect(built).not.toContain('#internal')
  })

  it('should not let a wildcard `paths` entry shadow real packages when loading meta', async () => {
    expect(JSON.parse(await read(dirs.loader!, 'dist/module.json'))).toMatchObject({ name: 'my-module', configKey: 'my-module' })
  })
})

describe('a module whose code Node cannot load', () => {
  it('should fail to build and prepare, with how to rewrite each import and each piece of syntax', async () => {
    const line = (await read(dirs.unloadable!, 'src/module.ts')).split('\n').findIndex(line => line.includes('./utils.js')) + 1
    for (const name of ['unloadable', 'unloadable:prepare']) {
      const output = withoutGuide(expectFailed(name))
      expect(output, name).toContain('NUXT_MB_B0001')
      expect(output, name).toContain([
        '  - src/levels.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
        '  - src/module.ts:1:37: `../package.json` is JSON (use `import pkg from \'../package.json\' with { type: \'json\' }` and read `pkg.version`; destructuring `pkg` bundles the whole file)',
        '  - src/module.ts:4:1: `enum` (use an `as const` object and a union type of its values)',
        '  - src/module.ts:5:28: parameter property (declare the field and assign it in the constructor)',
      ].join('\n'))
      expect(output, name).toMatch(/src\/module\.ts:\d+:\d+: angle-bracket type assertion \(write `value as Type`\)/)
      expect(output, name).toContain([
        `  - src/module.ts:${line}:31: \`./utils.js\` (use \`./utils.ts\`)`,
        `  - src/module.ts:${line + 1}:24: \`./helpers\` (use \`./helpers.ts\`)`,
        `  - src/module.ts:${line + 2}:21: \`./kit\` (use \`./kit/index.ts\`)`,
      ].join('\n'))
      expect(output, name).not.toContain(`:${line + 3}:`)
    }
    expect(exists(dirs.unloadable!, 'dist')).toBe(false)
  })

  it('should fail and remove the output when the built module cannot be loaded', () => {
    expect(expectFailed('unloadableDist')).toContain('[NUXT_MB_B0002] Cannot load `dist/module.mjs` to write `module.json`: fails once built')
    expect(exists(dirs.unloadableDist!, 'dist')).toBe(false)
  })
})

describe('a module whose declarations cannot be generated', () => {
  it('should surface isolated declaration diagnostics when the tsconfig opts in', () => {
    const output = expectFailed('isolatedError')
    expect(output).toContain('NUXT_MB_B0202')
    expect(output).toMatch(/TS90\d\d/)
    expect(output).not.toContain('NUXT_MB_B0203')
    expect(exists(dirs.isolatedError!, 'dist')).toBe(false)
  })

  it('should explain type errors that prevent declaration generation', () => {
    const output = expectFailed('typeError')
    expect(output).toContain('[plugin nuxt-module-builder:src/runtime]')
    expect(output).not.toContain('[plugin transpile-dir]')
    expect(output).toMatch(/TS4094/)
    expect(output).toContain('NUXT_MB_B0203')
    expect(output).toMatch(/cannot reference by name.*explicit type annotation, such as `ReturnType<typeof fn>` for a value produced by an imported `fn`:\n- `defineCachedHandler` in \S*src\/runtime\/server\/cached\.ts:3\n/)
    expect(exists(dirs.typeError!, 'dist')).toBe(false)
  })

  it('should fail on portability errors in a single-file component and in a script sharing its program', () => {
    const output = expectFailed('vueError')
    expect(output).toMatch(/components\/Cached\.vue\(4,14\): error TS(?:2742|2883)/)
    expect(output).toMatch(/server\/cached\.ts\(3,14\): error TS(?:2742|2883)/)
    expect(output).toMatch(/cannot reference by name.*:\n(?:- `\w+` in \S+\n)*- `cachedHandler` in \S*src\/runtime\/components\/Cached\.vue:4\n/)
    expect(output).toMatch(/\n- `defineCachedHandler` in \S*src\/runtime\/server\/cached\.ts:3\n/)
    expect(output).toContain('NUXT_MB_B0203')
    expect(exists(dirs.vueError!, 'dist')).toBe(false)
  })
})

describe('tsconfig lookup', () => {
  it('should read a file of a referenced project from source when a runtime file reaches it', async () => {
    expect(expectBuilt('referencedSource')).not.toContain('TS6305')
    expect(await read(dirs.referencedSource!, 'dist/kit/gen.d.ts')).toBe('export declare const gen: () => () => void;\n')
  })

  it('should generate declarations for each project of a solution-style tsconfig', async () => {
    expectBuilt('solution')
    expect(await read(dirs.solution!, 'dist/runtime/server/api/[id].get.d.ts')).toMatch(/=> string;/)
    expect(await read(dirs.solution!, 'dist/runtime/composables/useAliasedApp.d.ts')).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
    expect(exists(dirs.solution!, 'dist/runtime/components/TestMe.vue.d.ts')).toBe(true)
  })

  it('should use a tsconfig from a parent directory, naming runtime types by package when it maps the package into the store', async () => {
    expectBuilt('parent')
    expect(await read(dirs.parent!, 'dist/runtime/composables/useAliasedApp.d.ts')).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
    expect(await read(dirs.parent!, 'dist/runtime/logger.d.ts')).toMatch(/import\("fake-logger"\)\.LoggerInstance/)
  })

  it('should generate declarations with the module\'s own `.nuxt` when the tsconfig takes its types from a playground', async () => {
    expect(expectBuilt('routes')).toContain('[NUXT_MB_C0301] `../tsconfig.json` takes its generated types')
    expect(expectBuilt('routes')).toContain('fix: Add a `tsconfig.json` to the module directory that references')
    expect(await read(dirs.routes!, 'playground/.nuxt/types/nitro-routes.d.ts')).toContain('/api/secret')
    for (const file of await listFiles(join(dirs.routes!, 'dist'))) {
      if (file.includes('.')) {
        expect(await read(dirs.routes!, 'dist', file), file).not.toMatch(/must-not-be-published|playground|\.nuxt/)
      }
    }
  })

  it('should type the responses of routes the module registers and leave other routes unknown', async () => {
    const dir = dirs.routes!
    expect(await read(dir, '.nuxt/types/nitro-routes.d.ts')).toContain('/api/own')
    const { default: ts } = await import('typescript')
    const files = ts.getParsedCommandLineOfConfigFile(join(dir, '.nuxt/tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!.fileNames
    expect(files.map(file => relative(dir, file)).filter(file => file.includes('routes.d.ts')).sort()).toEqual(['../sibling/types/routes.d.ts', 'docs/types/routes.d.ts', 'playground/types/routes.d.ts'])
    expect(await read(dir, 'dist/runtime/composables/useOwn.d.ts')).toBe(`export declare const useOwn: () => import("nuxt/app").AsyncData<{\n    own: "module-owned";\n} | undefined, import("nuxt/app").NuxtError<unknown> | undefined>;\n`)
    expect(await read(dir, 'dist/runtime/composables/useGlobal.d.ts')).toBe('export declare const useGlobal: () => Fake.Thing;\n')
    expect(output('routes')).not.toMatch(/type errors? (?:was|were) reported/)
    for (const name of ['useSecret', 'useSibling', 'useDocs']) {
      expect(await read(dir, `dist/runtime/composables/${name}.d.ts`), name).toBe(`export declare const ${name}: () => import("nuxt/app").AsyncData<unknown, import("nuxt/app").NuxtError<unknown> | undefined>;\n`)
    }
    const component = await read(dir, 'dist/runtime/components/Routes.vue.d.ts')
    expect(component).toContain('own: import("vue").Ref<{\n        own: "module-owned";\n    } | undefined, {\n        own: "module-owned";\n    } | undefined>;')
    expect(component).toContain('secret: import("vue").Ref<unknown, unknown>;')
  })
})

describe('tsdown configs', () => {
  it.each([
    ['an object', 'object', 'out'],
    ['an array', 'array', 'out'],
    ['a function', 'function', 'dist'],
  ])('should prepare and build a module whose tsdown config exports %s', async (_, shape, outDir) => {
    expect(expectBuilt(`${shape}:prepare`)).not.toContain('ERROR')
    expect(exists(dirs[shape]!, '.nuxt/tsconfig.json')).toBe(true)
    expect(exists(dirs[shape]!, '.nuxt/module-builder/types.d.mts')).toBe(true)
    expectBuilt(shape)
    const out = join(dirs[shape]!, outDir)
    expect(await read(out, 'shared/value.mjs')).toContain(`from "./other.mjs"`)
    expect(exists(out, 'helpers.mjs')).toBe(true)
    expect(exists(out, 'types.d.mts')).toBe(true)
    expect(JSON.parse(await read(out, 'module.json'))).toMatchObject({ name: 'my-module' })
    if (shape === 'array') {
      expect(await read(dirs[shape]!, 'dist-cli/cli.mjs')).toContain(`const cli = "cli"`)
    }
  })

  it('should build with the tsdown config\'s `outDir` and `sourcemap` unless `--outDir` and `--sourcemap` override them', () => {
    expect(exists(dirs.object!, 'out/module.mjs.map')).toBe(true)
    expect(exists(dirs.object!, 'out/runtime/plugins/plugin.js.map')).toBe(true)
    expect(exists(dirs.object!, 'dist')).toBe(false)
    expectBuilt('flags')
    expect(exists(dirs.flags!, 'custom/module.json')).toBe(true)
    expect(exists(dirs.flags!, 'custom/module.mjs.map')).toBe(false)
    expect(exists(dirs.flags!, 'custom/runtime/plugins/plugin.js.map')).toBe(false)
  })

  it('should refuse `hooks` in `builder()` and point at tsdown\'s own', () => {
    for (const name of ['builderHooks', 'builderHooks:prepare']) {
      expect(expectFailed(name), name).toContain('[NUXT_MB_C0008]')
    }
  })

  it('should fail to prepare with a tsdown config whose `cwd` is another directory', () => {
    expect(expectFailed('configCwd')).toContain('[NUXT_MB_C0007] `tsdown.config.ts` sets `cwd`')
    expectBuilt('configCwd:fixed')
  })

  it('should fail on a tsdown config that Node cannot load', () => {
    for (const name of ['configEnum', 'configEnum:prepare']) {
      const output = expectFailed(name)
      expect(output, name).toContain('tsdown.config.ts:2:1: `enum` (use an `as const` object and a union type of its values)')
      expect(output, name).toContain('[NUXT_MB_B0001]')
    }
  })

  it('should fail on a tsdown config without `builder()` and show how to add it', () => {
    for (const name of ['withoutPlugin', 'withoutPlugin:prepare']) {
      const output = name.endsWith(':prepare') ? withoutGuide(expectFailed(name)) : expectFailed(name)
      expect(output, name).toContain('[NUXT_MB_C0005] `tsdown.config.ts`')
      expect(output, name).toContain([
        '├▶ fix: Add the plugin:',
        '│',
        `│    import { builder } from '@nuxt/module-builder/tsdown'`,
        `│    import { defineConfig } from 'tsdown'`,
        '│',
        `│    export default defineConfig({`,
        `│      plugins: [builder()],`,
        `│    })`,
        '╰▶ see: ',
      ].join('\n'))
    }
    expect(expectFailed('entriesOnly')).toContain('[NUXT_MB_C0005] `tsdown.config.ts`')
    expect(exists(dirs.entriesOnly!, 'dist')).toBe(false)
  })

  it('should load the package root without tsdown, and point at installing it to build', () => {
    expect(expectBuilt('withoutTsdown:root').trim()).toBe('build,defineBuildConfig,prepare')
    expect(expectFailed('withoutTsdown')).toContain('[NUXT_MB_B0003]')
  })
})

describe('prepare', () => {
  it('should augment the same interfaces from the types `prepare` writes as from `dist`, through star re-exports', async () => {
    expectBuilt('starExports:prepare')
    expectBuilt('starExports')
    const shims = async (file: string) => (await read(dirs.starExports!, file)).match(/^declare module '[^']+' \{\n[\s\S]*?\n\}$/gm)
    const sourceShims = await shims('.nuxt/module-builder/types.d.mts')
    expect(sourceShims).toEqual(await shims('dist/types.d.mts'))
    expect(sourceShims).toEqual([
      `declare module '#app' {\n  interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}\n}`,
      `declare module '@nuxt/schema' {\n  interface NuxtHooks extends ModuleHooks {}\n  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}\n}`,
    ])
    for (const index of [0, 1]) {
      const { output } = result(`starExports:probe-${index}`)
      expect(output.split('\n').filter(line => /^(?:src|dist|\.nuxt\/module-builder)\/|^probe-\d\.ts/.test(line)), String(index)).toEqual([])
    }
  })

  it('should prepare a module that lists its own package in `.nuxtrc` and `nuxt.config`, with or without `dist`', async () => {
    const references = async (dir: string) => (await read(dir, '.nuxt/nuxt.node.d.ts')).split('\n').filter(line => line.includes('types="self-listed-module"') || line === '/// <reference path="module-builder/types.d.mts" />')
    for (const name of ['selfListedDist', 'selfListedSource']) {
      expect(expectBuilt(name).match(/\[setup\] .*/g), name).toEqual(['[setup] from-config'])
      expect(await references(dirs[name]!), name).toEqual(['/// <reference path="module-builder/types.d.mts" />'])
    }
  })

  it('should resolve the module\'s own package to declarations of module code in its app, server and shared tsconfigs', async () => {
    const dir = dirs.ownPackage!
    expectBuilt('ownPackage')
    expect(expectBuilt('ownPackage:typecheck')).toBe('')
    for (const name of ['app', 'server', 'shared']) {
      const files = expectBuilt(`ownPackage:${name}`).split('\n').map(file => file.trim())
      expect(files, name).not.toContain(join(dir, 'src/module.ts'))
      expect(files, name).not.toContain(join(dir, 'src/utils.ts'))
      expect(files, name).not.toContain(join(dir, 'src/helpers.ts'))
      expect(files, name).toContain(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))
    }
    expect(output('ownPackage:app')).toContain(join(dir, '.nuxt/module-builder/declarations/src/utils.d.ts'))
  })

  it('should generate tsconfigs for the module entry, without the playground or the workspace, and with app aliases and root options for module code', async () => {
    const generated = async (name: string) => JSON.parse(await read(dirs.ownPackage!, `.nuxt/tsconfig.${name}.json`))
    const [node, app] = [await generated('node'), await generated('app')]
    expect(node.include).toContain('../src/*.ts')
    expect(node.compilerOptions.paths['#app']).toBeDefined()
    expect(node.compilerOptions.paths['#components']).toBeDefined()
    expect(node.compilerOptions.types).toContain('vitest/importMeta')
    expect(app.exclude).toContain('../playground')
    expect(app.include).not.toContain('../../**/*')
    expect(app.include).toContain('../src/runtime')
    for (const name of ['app', 'node', 'server', 'shared']) {
      const { include, exclude } = await generated(name)
      expect([...include, ...exclude].filter((pattern: string) => pattern.startsWith('../src/dist')), name).toEqual([])
    }
  })

  it('should let module code import `.ts` files in every generated tsconfig when Nuxt does not set `allowImportingTsExtensions`', async () => {
    for (const name of ['tsconfig.app', 'tsconfig.node', 'tsconfig.server', 'tsconfig.shared', 'tsconfig']) {
      expect(JSON.parse(await read(dirs.ownPackage!, `.nuxt/${name}.json`)).compilerOptions.allowImportingTsExtensions, name).toBe(true)
    }
  })

  it('should write the declarations of module code with oxc when its tsconfig sets `isolatedDeclarations`', async () => {
    const dir = dirs.ownPackageIsolated!
    expect(expectBuilt('ownPackageIsolated')).not.toContain('NUXT_MB_B0204')
    expect(await read(dir, '.nuxt/module-builder/declarations/src/nested/payload.d.ts')).toContain('interface Payload')
    const moduleDeclaration = await read(dir, '.nuxt/module-builder/declarations/src/module.d.ts')
    expect(moduleDeclaration).toContain('from "./nested/payload.js"')
    expect(moduleDeclaration).toContain('from "./nested/shape.js"')
    expect(expectBuilt('ownPackageIsolated:typecheck')).toBe('')
    const files = expectBuilt('ownPackageIsolated:app')
    expect(files).toContain(join(dir, '.nuxt/module-builder/declarations/src/nested/payload.d.ts'))
    expect(files).not.toContain(join(dir, 'src/nested/payload.ts'))
    expect(files).not.toContain(join(dir, 'src/nested/shape.ts'))
  })

  it('should warn about a declaration error in module code, and write the other declarations', () => {
    const output = expectBuilt('ownPackageError')
    expect(output).toContain('[NUXT_MB_B0204]')
    expect(output).toContain('src/logger.ts(3,14): error TS2883')
    expect(output).toContain('fix: Give each export that an error names an explicit type annotation')
    expect(exists(dirs.ownPackageError!, '.nuxt/module-builder/declarations/src/module.d.ts')).toBe(true)
    expect(exists(dirs.ownPackageError!, '.nuxt/module-builder/declarations/types.d.mts')).toBe(true)
  })

  it('should write only the declarations of module code that the declarations of its entries refer to', () => {
    expect(output('ownPackageError')).not.toContain('src/unused.ts')
    expect(exists(dirs.ownPackageError!, '.nuxt/module-builder/declarations/src/unused.d.ts')).toBe(false)
  })

  it('should name a dependency by its package in the declarations of module code when only a runtime file imports it', async () => {
    expect(output('ownPackageError')).not.toContain('src/styles.ts')
    expect(await read(dirs.ownPackageError!, '.nuxt/module-builder/declarations/src/styles.d.ts')).toContain('import("fake-format").Format')
  })

  it('should list the TypeScript files that no referenced project includes, by directory, outside CI', () => {
    expect(expectBuilt('unchecked:ci')).not.toContain('NUXT_MB_C0303')
    const notice = expectBuilt('unchecked').split('\n').filter(line => line.includes('NUXT_MB_C0303'))
    expect(notice).toHaveLength(1)
    expect(notice[0]).toContain('[NUXT_MB_C0303] No project that `tsconfig.json` references includes these TypeScript files, so `vue-tsc -b` does not type check them: `eslint.config.ts`, `test/` (4 files), `vitest.config.ts`.')
  })

  it('should type check tests and config files with a `tsconfig.test.json` that extends the node tsconfig', () => {
    expect(expectBuilt('unchecked:test')).not.toContain('NUXT_MB_C0303')
    expect(expectBuilt('unchecked:typecheck')).toBe('')
    const files = expectBuilt('unchecked:files').split('\n').map(file => file.trim())
    for (const file of ['test/unit.ts', 'test/utils.ts', 'eslint.config.ts', 'vitest.config.ts']) {
      expect(files, file).toContain(join(dirs.unchecked!, file))
    }
    expect(files.filter(file => file.includes('/test/nuxt/') || file.includes('/test/fixtures/'))).toEqual([])
  })

  it('should check and declare a server directory outside `src/runtime/server` with a tsconfig that extends the server tsconfig', async () => {
    const error = 'src/runtime/nitro/plugin.ts(1,36): error TS2584: Cannot find name \'document\'.'
    expect(expectBuilt('nitroDir')).toContain(error)
    expect(expectFailed('nitroDir:typecheck')).toContain(error)
    expect(JSON.parse(await read(dirs.nitroDir!, '.nuxt/tsconfig.app.json')).exclude).toContain('../src/runtime/nitro')
    expect(await read(dirs.nitroDir!, 'dist/runtime/nitro/plugin.d.ts')).toContain('export declare const title: () => string;')
  })

  it('should not report `.ts` imports in module code that a runtime file imports, and keep their declarations', async () => {
    expect(expectBuilt('nitroDir')).not.toContain('TS5097')
    expect(await read(dirs.nitroDir!, 'dist/kit/gen.d.ts')).toBe(`import type { Helper } from './helper.js';\nexport declare const gen: () => Helper;\n`)
  })

  it('should explain a tsconfig above the module that cannot be read', () => {
    const output = expectFailed('noTsconfig')
    expect(output).toContain('[NUXT_MB_C0302] Cannot read `../tsconfig.json`, the nearest tsconfig above the module, which has no `tsconfig.json` of its own: ')
    expect(output).toContain('fix: Give the module a `tsconfig.json` and a `tsconfig.module.json` of its own')
  })

  it('should keep `.nuxt/tsconfig.json` one program over the module\'s sources, with the generated tsconfigs adapted', async () => {
    const dir = dirs.legacyPrepare!
    expectBuilt('legacyPrepare')
    const generated = async (name: string) => JSON.parse(await read(dir, `.nuxt/${name}.json`))
    expect((await generated('tsconfig.app')).compilerOptions.paths['my-module']).toEqual(['./module-builder/declarations/types.d.mts'])
    const legacy = await generated('tsconfig')
    expect(legacy.compilerOptions.paths['my-module']).toBeUndefined()
    expect(legacy.include).not.toContain('./module-builder/declarations/types.d.mts')
    expect(legacy.exclude).not.toContain('../src/runtime/server')
    const typecheck = output('legacyPrepare:typecheck')
    expect(typecheck).not.toMatch(/error TS5\d{3}/)
    expect(typecheck.split('\n').filter(line => /^(?:src|\.nuxt)\//.test(line))).toEqual([])
    const files = output('legacyPrepare:files')
    expect(files).toContain(join(dir, 'src/module.ts'))
    expect(files).toContain(join(dir, 'src/runtime/server/options.ts'))
    expect(files).not.toContain(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))
  })
})

describe('the example', () => {
  const typeErrors = (name: string) => output(name).split('\n').filter(line => line.includes('error TS'))

  it('should type the playground and its config through the module\'s exports, from its sources without `dist` and from `dist`', () => {
    for (const name of ['source:app', 'source:node', 'dist:app', 'dist:node']) {
      expect(typeErrors(name), name).toEqual([])
    }
    expect(sourceWithoutDist).toBe(true)
  })

  it('should render the playground with the module installed by name', async () => {
    for (const flow of ['source', 'dist']) {
      expectBuilt(`${flow}:generate`)
      expect(await read(dirs[flow]!, 'playground/.output/public/index.html')).toContain('Nuxt module playground!')
    }
    expect(await read(dirs.source!, 'playground/.nuxt/types/plugins.d.ts')).toContain('src/runtime/plugins/plugin')
  })

  it('should refuse to build source exports for a pack by npm, including when a pnpm script runs it', () => {
    const { output, exitCode } = result('source:npm')
    expect(exitCode, `${packProbeContext()}\n${output}`).not.toBe(0)
    expect(output).toMatch(/`npm(?:@[\d.]+)?` packs these fields of `package\.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `exports`, `main`, `types` \(`\.\/\.nuxt\/module-builder\/types\.d\.mts`, `\.\/src\/module\.ts`, `\.\/src\/utils\.ts`\)\./)
    expect(output).toContain('[NUXT_MB_C0104]')
  })

  it('should pack the `dist` paths in `publishConfig` with pnpm, and `dist` with npm, without warnings', async () => {
    const packed = async (dir: string) => JSON.parse((await succeed(run('tar', ['-xzOf', join(dir, '.pack/my-module-1.0.0.tgz'), 'package/package.json']))))
    expect(await packed(dirs.source!)).toMatchObject({
      exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' } },
      main: './dist/module.mjs',
      types: './dist/types.d.mts',
    })
    expect(await packed(dirs.source!)).not.toHaveProperty('publishConfig')
    const { publishConfig } = JSON.parse(await read(exampleDir, 'package.json'))
    expect(await packed(dirs.dist!)).toMatchObject({ exports: publishConfig.exports, main: publishConfig.main })
    for (const name of ['source:pack', 'dist:pack']) {
      const output = expectBuilt(name)
      expect(output, name).toContain('Build complete')
      expect(output, name).not.toMatch(/\bWARN\b/)
    }
    expect(output('source:pack')).toContain('[publint] No issues found')
    expectBuilt('source:attw')
  })

  describe('`dist`', () => {
    const dist = () => join(dirs.dist!, 'dist')

    it('should generate all files', async () => {
      expect(await listFiles(dist())).toMatchInlineSnapshot(`
        [
          "module.d.mts",
          "module.json",
          "module.mjs",
          "runtime",
          "runtime/assets",
          "runtime/assets/config.json",
          "runtime/components",
          "runtime/components/JsxComponent.d.ts",
          "runtime/components/JsxComponent.jsx",
          "runtime/components/TestMe.css",
          "runtime/components/TestMe.d.vue.ts",
          "runtime/components/TestMe.vue",
          "runtime/components/TestMe.vue.d.ts",
          "runtime/components/TestMeSetup.d.vue.ts",
          "runtime/components/TestMeSetup.vue",
          "runtime/components/TestMeSetup.vue.d.ts",
          "runtime/composables",
          "runtime/composables/useAliasedApp.d.ts",
          "runtime/composables/useAliasedApp.js",
          "runtime/composables/useAppNuxt.d.ts",
          "runtime/composables/useAppNuxt.js",
          "runtime/composables/useWrappedFetch.d.ts",
          "runtime/composables/useWrappedFetch.js",
          "runtime/plugins",
          "runtime/plugins/plugin.d.ts",
          "runtime/plugins/plugin.js",
          "types.d.mts",
          "utils.d.mts",
          "utils.mjs",
        ]
      `)
    })

    it('should reference `@nuxt/schema` rather than `nuxt/schema` in module declarations', async () => {
      const types = await read(dist(), 'module.d.mts')
      expect(types).toContain('import("@nuxt/schema")')
      expect(types).not.toContain('import("nuxt/schema")')
    })

    it('should copy non-code files in the runtime directory', async () => {
      expect(await read(dist(), 'runtime/components/TestMe.css')).toBe('.test-me{color:#639}')
    })

    it('should give every relative specifier in runtime declarations an extension that resolves', async () => {
      expect(await unresolvedSpecifiers(dist())).toEqual([])
    })

    it('should write types to output directory', async () => {
      expect(await read(dist(), 'types.d.mts')).toMatchInlineSnapshot(`
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

    it('should generate module metadata as separate JSON file', async () => {
      expect(JSON.parse(await read(dist(), 'module.json'))).toMatchObject({
        builder: { '@nuxt/module-builder': version, 'tsdown': tsdownVersion },
        configKey: 'myModule',
        name: 'my-module',
        version: '1.0.0',
      })
    })

    it('should generate typed plugin', async () => {
      const pluginDts = await read(dist(), 'runtime/plugins/plugin.d.ts')
      const appAlias = `import\\("nuxt/app"\\)`
      expect(pluginDts).toMatch(/^export type SharedTypeFromRuntime = 'shared-type';$/m)
      expect(pluginDts).toMatch(new RegExp(`declare const _default: ${appAlias}\\.Plugin<\\{\\s*injection: "injected";\\s*\\}> & ${appAlias}\\.ObjectPlugin<\\{\\s*injection: "injected";\\s*\\}>;`))
      expect(pluginDts).toMatch(/^export default _default;$/m)
    })

    it('should resolve every shape of `#app` alias in runtime declarations, and leak none of them', async () => {
      const declaration = await read(dist(), 'runtime/composables/useAliasedApp.d.ts')
      expect(declaration).toMatch(/declare const useAppInstance: \(\) => import\("nuxt\/app"\)\.NuxtApp;/)
      expect(declaration).toMatch(/declare const useAppRouter: \(\) => import\("vue-router"\)\./)
      expect(declaration).toMatch(/declare const useAppCookie: \(name: string\) => import\("nuxt\/app"\)\.CookieRef</)
      expect(await read(dist(), 'runtime/composables/useAppNuxt.d.ts')).toMatch(/declare const useAppFromNuxt: \(\) => import\("nuxt\/app"\)\.NuxtApp;/)
      for (const file of (await listFiles(join(dist(), 'runtime'))).filter(file => /\.d\.[^/]*ts$/.test(file))) {
        const contents = await read(dist(), 'runtime', file)
        expect(contents, file).not.toMatch(/(["'])#app(?:\/[^"']*)?\1/)
        expect(contents, file).not.toMatch(/import\("#app(?:\/[^"]*)?"\)/)
      }
    })

    it('should correctly add extensions to imports from runtime/ directory', async () => {
      const runtimeImport = staticImports(await read(dist(), 'module.d.mts')).find(i => i.specifier.includes('runtime'))
      expect(runtimeImport!.code.trim()).toMatchInlineSnapshot(`"import { SharedTypeFromRuntime } from "./runtime/plugins/plugin.js";"`)
    })

    it('should generate components', async () => {
      for (const file of ['TestMe.vue', 'TestMe.vue.d.ts', 'TestMeSetup.vue', 'TestMeSetup.vue.d.ts', 'TestMeSetup.d.vue.ts']) {
        await expect((await read(dist(), 'runtime/components', file)).replace(/\r\n/g, '\n')).toMatchFileSnapshot(`__snapshots__/${file}`)
      }
    })

    it('should generate wrapped composables', async () => {
      const expectedErrorType = satisfies(nuxtVersion, '^3') ? 'null' : 'undefined'
      const errorType = satisfies(nuxtVersion, '^3')
        ? 'import\\("ofetch"\\)\\.FetchError<any>'
        : '(?:import\\("ofetch"\\)\\.FetchError<any>|import\\("nuxt/app"\\)\\.NuxtError<unknown>)'
      expect(await read(dist(), 'runtime/composables/useWrappedFetch.d.ts')).toMatch(new RegExp(`^export declare const useWrappedFetch: \\(\\) => import\\("nuxt/app"\\)\\.AsyncData<unknown, ${errorType} \\| ${expectedErrorType}>;$`, 'm'))
    })

    it('should preserve JSX in runtime files for the app to compile', async () => {
      expect(exists(dist(), 'runtime/components/JsxComponent.js')).toBe(false)
      await expect(await read(dist(), 'runtime/components/JsxComponent.jsx')).toMatchFileSnapshot('__snapshots__/JsxComponent.jsx')
      await expect(await read(dist(), 'runtime/components/JsxComponent.d.ts')).toMatchFileSnapshot('__snapshots__/JsxComponent.d.ts')
    })
  })
})
