import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { emptyEntry, transpileDir } from '../src/rolldown/index.ts'
import type { ExternalImport } from '../src/rolldown/index.ts'

const root = fileURLToPath(new URL('../.temp-rolldown-plugin', import.meta.url))
const cwd = join(root, 'project')
const dist = join(cwd, 'dist')

const files: Record<string, string> = {
  'shared/helper.ts': `export const helper = 'outside the project'\n`,
  'project/package.json': JSON.stringify({ name: 'fixture', type: 'module', private: true }),
  'project/tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      verbatimModuleSyntax: true,
      jsx: 'preserve',
      jsxImportSource: 'vue',
      allowImportingTsExtensions: true,
      noEmit: true,
      paths: { '#virtual/*': ['./virtual/*'] },
    },
    include: ['src/**/*', 'virtual/**/*'],
    vueCompilerOptions: { strictTemplates: false },
  }),
  'project/virtual/config.ts': `export const config: { name: string } = { name: 'virtual' }\n`,
  'project/src/index.ts': `export const host = 'bundled by tsdown'\n`,
  'project/src/types.ts': `export interface Options { enabled: boolean }\n`,
  'project/src/shared.ts': `export const shared = 1\n`,
  'project/src/model/index.ts': `export type * from './collection'\nexport type { Shape } from './shape'\nexport * from './common'\n`,
  'project/src/model/collection.ts': `export interface Collection { items: string[] }\n`,
  'project/src/model/shape.ts': `export interface Shape { kind: string }\nexport const shapes: string[] = []\n`,
  'project/src/model/common.ts': `export interface Common { id: string }\n`,
  'project/src/lib/index.ts': [
    `import 'side-effect-package'`,
    `import { type Options, defaults } from './options'`,
    `import type { Unused } from './unused'`,
    `import { shared } from '../shared'`,
    `import { helper } from '../../../shared/helper'`,
    `import { config } from '#virtual/config'`,
    `import Hello from './components/Hello.vue'`,
    `import Button from './components/Button'`,
    `import { nested } from './nested'`,
    `import data from './assets/data.json'`,
    `import './styles/main.css'`,
    ``,
    `export * from './reexported'`,
    `export { shared, helper, config, Hello, Button, nested, data }`,
    `export const use = (options: Options = defaults): Unused | undefined => (options.enabled ? undefined : undefined)`,
    `export const lazy = () => import('./lazy')`,
    ``,
  ].join('\n'),
  'project/src/lib/options.ts': `import type { Options as Root } from '../types'\nexport type Options = Root\nexport const defaults: Options = { enabled: true }\n`,
  'project/src/lib/unused.ts': `export interface Unused { never: true }\n`,
  'project/src/lib/reexported.ts': `export const reexported = true\n`,
  'project/src/lib/lazy.ts': `export const lazy = true\n`,
  'project/src/lib/model.ts': `import type { Collection, Common, Shape } from '../model'\n\nexport const describe = (collection: Collection, shape: Shape, common: Common): string => [collection.items.length, shape.kind, common.id].join()\n`,
  'project/src/lib/nested/index.ts': `export const nested = true\n`,
  'project/src/lib/components/Button.tsx': `export default function Button() {\n  return <button>Click</button>\n}\n`,
  'project/src/lib/components/Hello.vue': `<script setup lang="ts">\nimport type { Options } from '../../types'\nimport { defaults } from '../options'\nimport { helper } from '../../../../shared/helper'\ndefineProps<{ options: Options }>()\ndefineExpose({ defaults, helper })\n</script>\n\n<template>\n  <div>{{ options.enabled }}</div>\n</template>\n`,
  'project/src/lib/components/Other.vue': `<script setup lang="ts">\ndefineProps<{ label: string }>()\n</script>\n\n<template>\n  <span>{{ label }}</span>\n</template>\n`,
  'project/src/lib/routes/[id].get.ts': `export default (id: string) => id\n`,
  'project/src/lib/styles/main.css': `.a {\n  color: red;\n  & .b { color: blue; }\n}\n`,
  'project/src/lib/styles/_tokens.scss': `$brand: red;\n`,
  'project/src/lib/styles/theme.scss': `@use "tokens";\n.theme { color: tokens.$brand; }\n`,
  'project/src/lib/assets/data.json': `{ "answer": 42 }\n`,
  'project/src/lib/lib.spec.ts': `export const excluded = true\n`,
  'project/node_modules/side-effect-package/package.json': JSON.stringify({ name: 'side-effect-package', type: 'module', exports: './index.js' }),
  'project/node_modules/side-effect-package/index.js': `globalThis.sideEffect = true\n`,
  'project/node_modules/side-effect-package/index.d.ts': `export {}\n`,
}

const externals: Array<[string, ExternalImport['kind'], string]> = []

describe('transpileDir', () => {
  beforeAll(async () => {
    await rm(root, { recursive: true, force: true })
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(join(root, file, '..'), { recursive: true })
      await writeFile(join(root, file), contents)
    }
    const options = { cwd, config: false, entry: ['src/index.ts'], format: 'esm', dts: false, report: false } satisfies Parameters<typeof build>[0]
    await build({
      ...options,
      outDir: dist,
      plugins: [transpileDir({
        srcDir: 'src/lib',
        outBase: 'lib',
        resolveExternal(specifier, _importer, { kind, file }) {
          externals.push([specifier, kind, file.slice(root.length)])
          return { mirror: kind }
        },
      })],
    })
    await build({
      ...options,
      entry: emptyEntry,
      outDir: join(cwd, 'dist-raw'),
      plugins: [transpileDir({
        srcDir: 'src/lib',
        exclude: ['**/*.spec.ts', '**/Other.vue'],
        declaration: false,
        stylesheets: false,
      })],
    })
  }, 120_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const read = (file: string) => readFile(join(dist, file), 'utf8')

  it('should emit every file of the directory under its own name', async () => {
    expect((await readdir(dist, { recursive: true })).filter(file => !file.startsWith('_external') && file.includes('.')).sort()).toMatchInlineSnapshot(`
      [
        "index.mjs",
        "lib/assets/data.json",
        "lib/components/Button.d.ts",
        "lib/components/Button.js",
        "lib/components/Hello.d.vue.ts",
        "lib/components/Hello.vue",
        "lib/components/Hello.vue.d.ts",
        "lib/components/Other.d.vue.ts",
        "lib/components/Other.vue",
        "lib/components/Other.vue.d.ts",
        "lib/index.d.ts",
        "lib/index.js",
        "lib/lazy.d.ts",
        "lib/lazy.js",
        "lib/model.d.ts",
        "lib/model.js",
        "lib/nested/index.d.ts",
        "lib/nested/index.js",
        "lib/options.d.ts",
        "lib/options.js",
        "lib/reexported.d.ts",
        "lib/reexported.js",
        "lib/routes/[id].get.d.ts",
        "lib/routes/[id].get.js",
        "lib/styles/main.css",
        "lib/styles/theme.css",
        "lib/unused.d.ts",
        "lib/unused.js",
        "model/collection.d.ts",
        "model/common.d.ts",
        "model/index.d.ts",
        "model/shape.d.ts",
        "shared.d.ts",
        "shared.js",
        "types.d.ts",
      ]
    `)
  })

  it('should transpile each script on its own, dropping imports used only as types', async () => {
    expect(await read('lib/index.js')).toMatchInlineSnapshot(`
      "import "side-effect-package";
      import { defaults } from "./options.js";
      import { shared } from "../shared.js";
      import { helper } from "../_external/_/shared/helper.js";
      import { config } from "#virtual/config";
      import Hello from "./components/Hello.vue";
      import Button from "./components/Button.js";
      import { nested } from "./nested/index.js";
      import data from "./assets/data.json";
      import "./styles/main.css";
      export * from "./reexported.js";
      export { shared, helper, config, Hello, Button, nested, data };
      export const use = (options = defaults) => options.enabled ? undefined : undefined;
      export const lazy = () => import("./lazy.js");
      "
    `)
    expect(await read('lib/options.js')).toBe(`export const defaults = { enabled: true };\n`)
    expect(await read('lib/components/Button.js')).toContain(`import { jsx as _jsx } from "vue/jsx-runtime";`)
  })

  it('should generate declarations with the same specifiers', async () => {
    expect(await read('lib/index.d.ts')).toMatchInlineSnapshot(`
      "import 'side-effect-package';
      import { type Options } from './options.js';
      import type { Unused } from './unused.js';
      import { shared } from '../shared.js';
      import { helper } from '../_external/_/shared/helper.js';
      import { config } from '#virtual/config';
      import Hello from './components/Hello.vue';
      import Button from './components/Button.js';
      import { nested } from './nested/index.js';
      import data from './assets/data.json';
      import './styles/main.css';
      export * from './reexported.js';
      export { shared, helper, config, Hello, Button, nested, data };
      export declare const use: (options?: Options) => Unused | undefined;
      export declare const lazy: () => Promise<typeof import("./lazy.js")>;
      "
    `)
    expect(await read('lib/options.d.ts')).toContain(`import type { Options as Root } from '../types.js';`)
    expect(await read('lib/components/Hello.d.vue.ts')).toContain(`import type { Options } from '../../types.js';`)
    expect(await read('lib/components/Hello.vue.d.ts')).toBe(await read('lib/components/Hello.d.vue.ts'))
  })

  it('should give the imports of a single-file component the extension of their emitted target', async () => {
    const hello = await read('lib/components/Hello.vue')
    expect(hello).toContain(`import { defaults } from "../options.js";`)
    expect(hello).toContain(`import { helper } from "../../_external/_/shared/helper.js";`)
    expect(hello).not.toContain('../../types')
  })

  it('should mirror files outside the directory as scripts or as declarations only', async () => {
    expect(externals).toEqual([
      ['../shared', 'value', '/project/src/shared.ts'],
      ['../../../shared/helper', 'value', '/shared/helper.ts'],
      ['../model', 'type', '/project/src/model/index.ts'],
      ['../types', 'type', '/project/src/types.ts'],
      ['../../types', 'type', '/project/src/types.ts'],
      ['../../../../shared/helper', 'value', '/shared/helper.ts'],
      ['./collection', 'type', '/project/src/model/collection.ts'],
      ['./shape', 'type', '/project/src/model/shape.ts'],
      ['./common', 'type', '/project/src/model/common.ts'],
    ])
    expect(await read('shared.js')).toBe(`export const shared = 1;\n`)
    expect(existsSync(join(dist, 'types.js'))).toBe(false)
    expect(await read('types.d.ts')).toBe(`export interface Options {\n    enabled: boolean;\n}\n`)
    expect(await read('model/index.d.ts')).toBe(`export type * from './collection.js';\nexport type { Shape } from './shape.js';\nexport * from './common.js';\n`)
    expect(await read('model/shape.d.ts')).toContain('export declare const shapes: string[];')
    expect(await readdir(join(dist, '_external'), { recursive: true })).toEqual(['_', '_/shared', '_/shared/helper.d.ts', '_/shared/helper.js'])
  })

  it('should process stylesheets and copy other files', async () => {
    expect(await read('lib/styles/main.css')).toBe('.a{color:red}.a .b{color:#00f}')
    expect(await read('lib/styles/theme.css')).toBe('.theme {\n  color: red;\n}')
    expect(existsSync(join(dist, 'lib/styles/_tokens.scss'))).toBe(false)
    expect(await read('lib/assets/data.json')).toBe(files['project/src/lib/assets/data.json'])
    expect(existsSync(join(dist, 'lib/lib.spec.js'))).toBe(false)
  })

  it('should leave out declarations, stylesheet processing and excluded components when asked', async () => {
    const raw = join(cwd, 'dist-raw')
    const emitted = (await readdir(raw, { recursive: true })).filter(file => file.includes('.')).sort()
    expect(emitted.filter(file => /\.d\.|\.vue|\.mjs$|styles\//.test(file))).toEqual([
      'components/Hello.vue',
      'styles/_tokens.scss',
      'styles/main.css',
      'styles/theme.scss',
    ])
    expect(await readFile(join(raw, 'styles/theme.scss'), 'utf8')).toBe(files['project/src/lib/styles/theme.scss'])
    expect(await readFile(join(raw, 'components/Hello.vue'), 'utf8')).toContain('defineProps')
  })

  it('should emit a source map next to each script that links back to its source', async () => {
    const outDir = join(cwd, 'dist-maps')
    await build({
      cwd,
      config: false,
      entry: emptyEntry,
      format: 'esm',
      dts: false,
      report: false,
      outDir,
      plugins: [transpileDir({ srcDir: 'src/lib', outBase: 'lib', include: ['lazy.ts'], declaration: false, sourcemap: true })],
    })
    const code = await readFile(join(outDir, 'lib/lazy.js'), 'utf8')
    expect(code.trimEnd().split('\n').at(-1)).toBe('//# sourceMappingURL=lazy.js.map')
    const map = JSON.parse(await readFile(join(outDir, 'lib/lazy.js.map'), 'utf8'))
    expect(map.file).toBe('lazy.js')
    expect(map.sources).toEqual(['../../src/lib/lazy.ts'])
    expect(map.mappings).not.toBe('')
    expect(await readFile(join(outDir, 'lib', map.sources[0]), 'utf8')).toBe(files['project/src/lib/lazy.ts'])
  })
})
