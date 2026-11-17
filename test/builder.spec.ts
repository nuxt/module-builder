import { join } from 'pathe'
import { beforeAll, describe, expect, it } from 'vitest'

import { guide } from '../src/build/guide.ts'
import type { Result } from './utils.ts'
import { bin, cli, exists, fixture, read, repoRoot, run, tsdown, tsdownBin } from './utils.ts'

const PLUGIN = 'export default { plugins: [builder()] }\n'
const REFERENCES = (node: string, server = './.nuxt/tsconfig.server.json') => JSON.stringify({
  files: [],
  exclude: ['dist', 'node_modules', 'playground'],
  references: [node, './.nuxt/tsconfig.app.json', server, './.nuxt/tsconfig.shared.json'].map(path => ({ path })),
})
const FIELDS = `\nclass Fields { value!: string }\nexport const ownsField: boolean = Object.hasOwn(new Fields(), 'value')\n`
const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`
const sizeRows = (output: string) => [...output.matchAll(/(dist\/(?:module\.mjs|runtime\/))\s[^\n]*types/g)].map(match => match[1]).sort()

const dirs: Record<string, string> = {}
const results: Record<string, Result> = {}
const step = async (name: string, result: Promise<Result>) => {
  results[name] = await result
  return results[name]
}
const expectBuilt = (name: string) => {
  expect(results[name]!.exitCode, results[name]!.output).toBe(0)
  return results[name]!.output
}
const expectFailed = (name: string) => {
  expect(results[name]!.exitCode, results[name]!.output).not.toBe(0)
  return results[name]!.output
}

beforeAll(async () => {
  dirs.compose = await fixture('.temp-builder/compose', {
    config: `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const log = line => appendFileSync(join(import.meta.dirname, 'hooks.log'), line + '\\n')

export default {
  hooks: {
    'build:prepare'(ctx) {
      writeFileSync(join(ctx.options.cwd, 'src/generated.ts'), "export const generated: string = 'from build:prepare'\\n")
      mkdirSync(ctx.options.outDir, { recursive: true })
      writeFileSync(join(ctx.options.outDir, 'stale.txt'), '')
      log('build:prepare')
    },
    'build:done'(ctx) {
      log(\`build:done \${existsSync(join(ctx.options.outDir, 'module.json'))} \${existsSync(join(ctx.options.outDir, 'types.d.mts'))}\`)
    },
  },
  format: 'esm',
  dts: true,
  fixedExtension: true,
  platform: 'node',
  deps: { neverBundle: ['fake-ext'] },
  inputOptions(options) {
    log('inputOptions')
    return options
  },
  plugins: [
    {
      name: 'user',
      transform(code, id) {
        return id.replaceAll('\\\\', '/').endsWith('src/module.ts') ? code.replace('__USER__', 'replaced by a user plugin') : undefined
      },
    },
    builder({ entries: ['./src/utils'], externals: [/^#ext\\//] }),
    { name: 'config', generateBundle() { this.emitFile({ type: 'asset', fileName: 'config.cjs', source: 'module.exports = {}\\n' }) } },
  ],
}
`,
    pkg: pkg => ({
      ...pkg,
      exports: { ...pkg.exports, './config': './dist/config.cjs', './missing': './dist/missing.mjs' },
      imports: { '#ext/*': './src/ext/*.ts', '#internal/*': './src/internal/*.ts' },
      publishConfig: { imports: { '#ext/*': './dist/ext/*.mjs' } },
    }),
    module: source => [
      source,
      `import { generated } from './generated.ts'`,
      `import { ext } from 'fake-ext'`,
      `import { answer } from './runtime/utils/answer.ts'`,
      `export const refs: unknown[] = [generated, ext, answer, '__USER__']`,
      `export { ext as packageExt } from '#ext/value'`,
      `export { internal } from '#internal/value'`,
      `export const label: string = '#internal/label'`,
      '',
    ].join('\n'),
    files: {
      'node_modules/fake-ext/package.json': JSON.stringify({ name: 'fake-ext', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      'node_modules/fake-ext/index.js': `export const ext = 'bundled-fake-ext'\n`,
      'node_modules/fake-ext/index.d.ts': `export declare const ext: string\n`,
      'src/runtime/utils/answer.ts': `export const answer: number = 42\n`,
      'src/ext/value.ts': `export const ext: string = 'ext'\n`,
      'src/internal/value.ts': `export const internal: string = 'through imports'\n`,
    },
  })

  dirs.packageImports = await fixture('.temp-builder/package-imports', {
    config: `export default {\n  plugins: [builder({ externals: [/^#ext\\//] })],\n}\n`,
    pkg: pkg => ({ ...pkg, imports: { '#ext/*': './src/ext/*.ts' } }),
    module: source => `${source}export { ext } from '#ext/value'\n`,
    files: { 'src/ext/value.ts': `export const ext: string = 'ext'\n` },
  })

  for (const [name, exports] of Object.entries({ source: './src/module.ts', files: './lib/module.mjs' })) {
    dirs[`unpublishable-${name}`] = await fixture(`.temp-builder/unpublishable-${name}`, { config: PLUGIN, pkg: pkg => ({ ...pkg, exports: { '.': exports } }) })
  }

  const variants = {
    shared: `const plugin = builder()\n\nexport default [\n  { plugins: [plugin] },\n  { plugins: [plugin], outDir: 'dist-other' },\n]\n`,
    format: `export default {\n  plugins: [builder(), { name: 'override', tsdownConfig: () => ({ format: 'cjs' }) }],\n}\n`,
    entry: `export default {\n  plugins: [builder(), { name: 'override', tsdownConfig: () => ({ entry: { module: 'src/utils.ts' } }) }],\n}\n`,
    platform: `export default {\n  plugins: [builder(), { name: 'override', tsdownConfig: () => ({ platform: 'browser' }) }],\n}\n`,
    entryFileNames: `import { mkdirSync, writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\nexport default {\n  outputOptions: { entryFileNames: '[name].js' },\n  plugins: [\n    { name: 'partial', generateBundle() { mkdirSync(join(import.meta.dirname, 'dist'), { recursive: true }); writeFileSync(join(import.meta.dirname, 'dist/partial.txt'), '') } },\n    builder({ entries: ['./src/utils'] }),\n  ],\n}\n`,
    summary: `export default {\n  report: { summary: false },\n  plugins: [builder()],\n}\n`,
  }
  for (const [name, config] of Object.entries(variants)) {
    dirs[name] = await fixture(`.temp-builder/${name}`, { config })
  }

  dirs.contexts = await fixture('.temp-builder/contexts', {
    config: PLUGIN,
    remove: ['.nuxt'],
    pkg: pkg => ({ ...pkg, dependencies: { ...pkg.dependencies, 'fake-logger': '1.0.0', 'fake-shared': '1.0.0' } }),
    module: source => source
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addImports, addTemplate, addTypeTemplate, createResolver } from \'@nuxt/kit\'\nimport { moduleHelper } from \'./helpers/name.ts\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    _nuxt.options.alias[\'#my-types\'] = resolver.resolve(\'./runtime/types\')\n    addImports({ name: \'useThing\', from: resolver.resolve(\'./runtime/composables/useThing\') })\n    addTypeTemplate({ filename: \'module/my-module-names.d.ts\', getContents: () => \'declare module "#my-module/names" {\\n  export const names: string[]\\n}\\n\' }, { nuxt: false })\n    _nuxt.hook(\'prepare:types\', ({ tsConfig }) => { tsConfig.include?.push(\'./module/my-module-names.d.ts\') })\n    addTemplate({ filename: \'my-module-virtual.mjs\', getContents: () => \'export default 1\\n\' })\n    moduleHelper()'),
    files: {
      'types/virtual.d.ts': `declare module '#my-root-virtual' {\n  export const rootValue: string\n}\n`,
      'content.d.ts': `export * from './dist/content'\n`,
      'src/helpers/name.ts': `import { useNuxt } from '@nuxt/kit'\n\nexport type { Linked } from '../runtime/linked.ts'\nexport type Jsx = typeof import('../runtime/components/JsxComponent.tsx').default\nexport type Names = ReturnType<typeof import('../runtime/composables/useNames.ts').useNames>\n\nexport function moduleHelper(): unknown {\n  return import.meta.vitest ? undefined : useNuxt().options.myModule\n}\n\nexport const callInit = (): unknown => useNuxt().callHook('my-module:init', 'shared-type')\n`,
      'src/runtime/composables/useVirtual.ts': `import value from '#build/my-module-virtual'\n\nexport const useVirtual = (): unknown => value\n`,
      'src/runtime/composables/useNames.ts': `import { names } from '#my-module/names'\n\nexport const useNames = (): string[] => names\n`,
      'src/runtime/linked.ts': `import type { NuxtLink } from '#components'\n\nexport type Linked = typeof NuxtLink\n`,
      'src/env.d.ts': `declare const __MY_MODULE_FLAG__: boolean\n`,
      'ambient.d.ts': `declare module '#my-virtual' {\n  export const virtualValue: string\n}\n`,
      'src/runtime/server/virtual.ts': `import { virtualValue } from '#my-virtual'\nimport { rootValue } from '#my-root-virtual'\n\nexport const value: string = import.meta.vitest ? '' : virtualValue + rootValue\n`,
      'src/augments.d.ts': `declare module '#app' {\n  interface NuxtApp {\n    $thing: 'thing'\n  }\n}\n\nexport {}\n`,
      'src/runtime/composables/useAppThing.ts': `import { useNuxtApp } from '#app'\n\nexport const useAppThing = (): 'thing' | undefined => import.meta.vitest ? undefined : useNuxtApp().$thing\n`,
      'src/runtime/types/index.ts': `export type Trigger = 'onNuxtReady' | string[] | boolean\n`,
      'src/runtime/composables/useThing.ts': `export function useThing() {\n  return { loggedIn: __MY_MODULE_FLAG__, user: null as { name: string } | null }\n}\n`,
      'src/runtime/components/Triggered.vue': `<script setup lang="ts">\nimport type { Trigger } from '#my-types'\n\ndefineProps<{ trigger?: Trigger }>()\n</script>\n\n<template>\n  <div />\n</template>\n`,
      'src/runtime/components/ThingState.vue': `<script setup lang="ts">\nimport { useThing } from '#imports'\n\nconst { loggedIn, user } = useThing()\n</script>\n\n<template>\n  <slot v-bind="{ loggedIn, user }" />\n</template>\n`,
      'test/fixture/nuxt.config.ts': `export default defineNuxtConfig({})\n`,
      'src/runtime/fields.ts': FIELDS,
      'src/runtime/server/fields.ts': FIELDS,
      'tsconfig.server.json': JSON.stringify({ extends: './.nuxt/tsconfig.server.json', compilerOptions: { useDefineForClassFields: false } }),
      [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${store('fake-logger')}/index.js`]: `export const createLogger = () => ({ log: console.log })\n`,
      [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
      [`${store('fake-shared')}/index.js`]: `import { createLogger } from 'fake-logger'\nexport const createModuleLogger = () => createLogger()\n`,
      'src/runtime/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n`,
      'src/runtime/server/log.ts': `import { createLogger } from 'fake-logger'\n\nexport const serverLogger = createLogger()\n`,
      'tsconfig.json': JSON.stringify({ ...JSON.parse(REFERENCES('./.nuxt/tsconfig.node.json', './tsconfig.server.json')), compilerOptions: { types: ['vitest/importMeta'] } }),
    },
    links: {
      'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger': store('fake-logger'),
      'node_modules/fake-logger': store('fake-logger'),
      'node_modules/fake-shared': store('fake-shared'),
    },
  })

  const moduleProject = {
    'tsconfig.module.json': JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { erasableSyntaxOnly: true, useDefineForClassFields: false } }),
    'tsconfig.override.json': JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { useDefineForClassFields: true } }),
    'tsconfig.json': REFERENCES('./tsconfig.module.json'),
  }
  dirs.moduleProject = await fixture('.temp-builder/module-project', { config: PLUGIN, module: source => source + FIELDS, files: moduleProject })
  dirs.tsconfigOption = await fixture('.temp-builder/tsconfig-option', { config: `export default { tsconfig: 'tsconfig.override.json', plugins: [builder()] }\n`, module: source => source + FIELDS, files: moduleProject })
  dirs.singleTsconfig = await fixture('.temp-builder/single-tsconfig', {
    config: PLUGIN,
    module: source => source + FIELDS,
    files: { 'tsconfig.json': JSON.stringify({ extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground'] }) },
  })

  await Promise.all([
    step('compose', tsdown(dirs.compose)),
    step('packageImports', tsdown(dirs.packageImports)),
    ...['source', 'files'].flatMap(name => [
      step(`unpublishable-${name}:tsdown`, tsdown(dirs[`unpublishable-${name}`]!)),
      step(`unpublishable-${name}:cli`, cli(['build', dirs[`unpublishable-${name}`]!])),
    ]),
    ...Object.keys(variants).map(name => step(name, tsdown(dirs[name]!))),
    step('contexts', tsdown(dirs.contexts)).then(() => step('contexts:typecheck', run(bin('vue-tsc'), ['-b', '--noEmit'], { cwd: dirs.contexts }))),
    step('moduleProject', tsdown(dirs.moduleProject, [], { CI: '' })),
    step('tsconfigOption', tsdown(dirs.tsconfigOption)),
    step('singleTsconfig', tsdown(dirs.singleTsconfig)),
    step('published', run('node', [tsdownBin], { cwd: repoRoot })).then(() => step('published:import', run('node', ['--input-type=module', '-e', `const root = await import('@nuxt/module-builder')\nconst { builder } = await import('@nuxt/module-builder/tsdown')\nconsole.log(JSON.stringify(['builder' in root, builder().name]))`]))),
  ])
})

describe('builder', () => {
  it('should run the config\'s hooks before its own, so `build:prepare` can generate sources, and compose with its plugins and options', async () => {
    const dir = dirs.compose!
    expect(expectBuilt('compose')).not.toContain('Error')
    expect((await read(dir, 'hooks.log')).trim().split('\n')).toEqual(['build:prepare', 'inputOptions', 'build:done true true'])
    expect(exists(dir, 'dist/stale.txt')).toBe(false)
    const module = await read(dir, 'dist/module.mjs')
    expect(module).toContain('from build:prepare')
    expect(module).toContain('replaced by a user plugin')
    expect(module).toContain('from "fake-ext"')
    expect(module).not.toContain('bundled-fake-ext')
    expect(module).toContain('from "./runtime/utils/answer.js"')
    expect(JSON.parse(await read(dir, 'dist/module.json'))).toMatchObject({ name: 'my-module', configKey: 'myModule' })
  })

  it('should write files a plugin emits before checking the paths of `package.json`', async () => {
    expect(await read(dirs.compose!, 'dist/config.cjs')).toBe('module.exports = {}\n')
    const warning = expectBuilt('compose').split('\n').find(line => line.includes('do not exist after the build'))
    expect(warning).toContain('./dist/missing.mjs')
    expect(warning).not.toContain('config.cjs')
  })

  it('should refuse package `imports` that the output imports and that would not work once installed', async () => {
    expect(expectFailed('packageImports')).toContain(`The build output imports these \`imports\` of \`package.json\`, which would not work once installed. Pointing at TypeScript sources, which Node does not load from \`node_modules\`: \`#ext/*\` (\`./src/ext/*.ts\`).`)
    expect(exists(dirs.packageImports!, 'dist')).toBe(false)
    const module = await read(dirs.compose!, 'dist/module.mjs')
    expect(module).toContain('"#ext/value"')
    expect(module).toContain('through imports')
    expect(module).not.toContain('#internal/value')
  })

  it('should refuse to build when a published path points at a TypeScript source or at a file the pack leaves out', () => {
    const messages = {
      source: 'Pointing at TypeScript sources, which Node does not load from `node_modules`: `exports` (`./src/module.ts`).',
      files: 'Pointing at paths that the pack leaves out: `exports` (`./lib/module.mjs`).',
    }
    for (const [name, message] of Object.entries(messages)) {
      for (const command of ['tsdown', 'cli']) {
        expect(expectFailed(`unpublishable-${name}:${command}`), command).toContain(message)
      }
      expect(exists(dirs[`unpublishable-${name}`]!, 'dist')).toBe(false)
    }
  })

  it('should be published at `@nuxt/module-builder/tsdown`, not at the package root', () => {
    expectBuilt('published')
    expect(JSON.parse(expectBuilt('published:import'))).toEqual([false, 'nuxt-module-builder'])
  })

  it('should reject one plugin instance shared by two configs', () => {
    expect(expectFailed('shared')).toContain('The same `builder()` plugin is used in more than one tsdown config.')
  })

  it.each(['format', 'entry', 'platform'])('should fail when another plugin changes `%s`, which it sets', (option) => {
    expect(expectFailed(option)).toMatch(new RegExp(`Another tsdown plugin changed \`${option}\`.*, which \`builder\\(\\)\` sets\\. ${guide('options-builder-sets')}`))
    expect(exists(dirs[option]!, 'dist')).toBe(false)
  })

  it('should fail when `outputOptions` changes the file names of the bundled entries, and remove the partial output', () => {
    expect(expectFailed('entryFileNames')).toMatch(/The build did not emit `(module|utils)\.mjs`, `(module|utils)\.mjs`\./)
    expect(exists(dirs.entryFileNames!, 'dist')).toBe(false)
  })

  it('should break the size report down by entry and runtime directory only when it is a summary', () => {
    expect(sizeRows(expectBuilt('compose'))).toEqual(['dist/module.mjs', 'dist/runtime/'])
    expect(sizeRows(expectBuilt('summary'))).toEqual([])
  })
})

describe('with a root tsconfig that only lists references', () => {
  it('should type runtime components with their own context and pass the type check', async () => {
    const dir = dirs.contexts!
    expect(expectBuilt('contexts')).not.toContain('type error')
    expect(await read(dir, 'dist/runtime/components/ThingState.d.vue.ts')).toMatch(/loggedIn: boolean;\s+user: \{\s+name: string;\s+\} \| null;/)
    expect(await read(dir, 'dist/runtime/components/Triggered.vue')).toMatch(/type: \[\s*String,\s*Array,\s*Boolean\s*\]/)
    const generated = async (name: string) => JSON.parse(await read(dir, `.nuxt/tsconfig.${name}.json`))
    for (const name of ['app', 'node', 'server', 'shared']) {
      const config = await generated(name)
      expect(config.files, name).toEqual(expect.arrayContaining([join(dir, 'src/env.d.ts'), join(dir, 'ambient.d.ts'), join(dir, 'types/virtual.d.ts')]))
      expect(config.files, name).not.toContain(join(dir, 'src/augments.d.ts'))
      expect(config.compilerOptions.types, name).toContain('vitest/importMeta')
    }
    for (const name of ['nuxt', 'nuxt.node']) {
      expect(await read(dir, `.nuxt/${name}.d.ts`), name).toContain('/// <reference path="../src/augments.d.ts" />')
    }
    expect(await read(dir, '.nuxt/nuxt.shared.d.ts')).not.toContain('augments.d.ts')
    expect(await read(dir, '.nuxt/nuxt.node.d.ts')).toContain('/// <reference path="module-builder/types.d.mts" />')
    const buildTypes = (await read(dir, '.nuxt/types/build.d.ts')).split('\n')
    expect(buildTypes).toContain('declare module "#build/my-module-virtual";')
    expect(buildTypes).not.toContain('declare module "#build/my-module-virtual.mjs";')
    expect((await generated('app')).include).not.toContain('../**/*')
    expect(expectBuilt('contexts:typecheck')).toBe('')
  })

  it('should transform each runtime file with the referenced project that includes it', async () => {
    expect(await read(dirs.contexts!, 'dist/runtime/fields.js')).toContain('\tvalue;')
    expect(await read(dirs.contexts!, 'dist/runtime/server/fields.js')).not.toContain('value;')
  })

  it('should name a dependency in runtime declarations by its package when only another part of the module imports it', async () => {
    expect(await read(dirs.contexts!, 'dist/runtime/logger.d.ts')).toContain('import("fake-logger").LoggerInstance')
  })

  it('should give tsdown the project that includes the module entry, unless the config sets `tsconfig`', async () => {
    const ownsField = async (dir: string) => (await read(dir, 'dist/module.mjs')).includes('\tvalue;')
    const output = expectBuilt('moduleProject')
    expect(output).toContain('tsconfig: tsconfig.module.json')
    expect(output).toContain('Set `isolatedDeclarations: true` in `tsconfig.module.json`')
    expect(await ownsField(dirs.moduleProject!)).toBe(false)
    expect(expectBuilt('tsconfigOption')).toContain('tsconfig: tsconfig.override.json')
    expect(await ownsField(dirs.tsconfigOption!)).toBe(true)
    expect(expectBuilt('singleTsconfig')).toContain('tsconfig: tsconfig.json')
    expect(await read(dirs.singleTsconfig!, 'dist/module.d.mts')).toBe(await read(dirs.moduleProject!, 'dist/module.d.mts'))
  })
})
