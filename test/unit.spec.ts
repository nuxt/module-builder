import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { satisfies } from 'verkit'
import { version as nuxtVersion } from 'nuxt/package.json'
import { version } from '../package.json'
import { basename, dirname, join, resolve } from 'pathe'
import { parseTsconfig } from 'get-tsconfig'
import { analyseSources, finishBuild, hashGeneratedTypes, moduleTsconfigs, resolveBuild } from '../src/build/build.ts'
import type { BuildPlan } from '../src/build/build.ts'
import { resolveModuleOptions, resolveOutDir } from '../src/build/options.ts'
import { resolveCwdArg } from '../src/commands/_shared.ts'
import { moduleSpecifiers, rewriteSpecifiers, valueSpecifiers } from '../src/transpile/specifiers.ts'
import { logger, readPackageJson, relativeSpecifier } from '../src/utils.ts'
import { setupBuilder } from '../src/tsdown/setup.ts'
import { defaultReport, reportsSummary, sizeBreakdown } from '../src/tsdown/report.ts'
import { unchangedOutputs } from '../src/tsdown/unchanged.ts'
import type { Rolldown, UserConfig } from 'tsdown'
import { exec } from 'tinyexec'
import { runtimeExternals } from '../src/tsdown/externals.ts'
import { SERVER_ROUTES_STUB, createTsconfigResolver, declarationPaths, rootTsconfig, tsconfigPaths, typeResolutionFs, writeDerivedTsconfig, writeServerRoutesStub } from '../src/transpile/tsconfig.ts'
import { transformCss } from '../src/transpile/stylesheets.ts'
import { declarationTargets, rewriteRuntimeDeclarations } from '../src/build/aliases.ts'
import { checkLegacyCJSPaths, checkLegacyDeclarationPaths } from '../src/legacy/package-paths.ts'
import { checkMissingPaths, checkNode10DeclarationPaths, checkStaleTypesField, importsKeyFor, publishedPackage, selfReferencePaths, sourcePathsPackError, unpublishableImportsError, unpublishablePathsError } from '../src/build/package.ts'
import { writeSourceTypes, writeTypes } from '../src/build/types.ts'
import ts from 'typescript'
import { errorCodes, errors, GUIDE_URL, unwrapBuildError, warningCodes, warnings } from '../src/diagnostics.ts'
import { findModuleCodeIssues } from '../src/build/loader.ts'
import type { ModuleCodeIssue } from '../src/build/loader.ts'
import buildCommand from '../src/commands/build.ts'
import prepareCommand from '../src/commands/prepare.ts'
import { diagnostic, guideAnchors, reported } from './utils.ts'

const runtimeSrcDir = fileURLToPath(new URL('../example/src/runtime', import.meta.url))
const importer = fileURLToPath(new URL('../example/src/module.ts', import.meta.url))
const runtimeOutDir = '/dist/runtime'
const directories = (srcDir = runtimeSrcDir) => ({ outDir: '/dist', directories: [{ srcDir, outDir: runtimeOutDir, ext: 'js' as const }] })

function createResolver(packageName?: string) {
  const plugin = runtimeExternals({ ...directories(), packageName })
  const resolveId = plugin.resolveId as (this: unknown, id: string, importer?: string) => Promise<unknown>
  const context = {
    resolve: (id: string) => {
      if (!id.startsWith('.')) {
        return Promise.resolve(null)
      }
      return Promise.resolve({ id: join(runtimeSrcDir, id.replace('./runtime/', '')), external: false })
    },
  }
  return (id: string) => resolveId.call(context, id, importer)
}

describe('runtimeExternals', () => {
  it('should point relative runtime imports at their output, keeping the name of `.vue` and non-code files', async () => {
    await expect(createResolver()('./runtime/plugins/plugin')).resolves.toEqual({
      id: '/dist/runtime/plugins/plugin.js',
      external: true,
    })
    await expect(createResolver()('./runtime/components/TestMe.vue')).resolves.toEqual({
      id: '/dist/runtime/components/TestMe.vue',
      external: true,
    })
    await expect(createResolver()('./runtime/assets/config.json')).resolves.toEqual({
      id: '/dist/runtime/assets/config.json',
      external: true,
    })
  })

  it('should point runtime JSX imports at their `.jsx` output unless their JSX is compiled', async () => {
    await expect(createResolver()('./runtime/components/JsxComponent')).resolves.toEqual({
      id: '/dist/runtime/components/JsxComponent.jsx',
      external: true,
    })
    await expect(createResolver('my-module')('my-module/runtime/components/JsxComponent')).resolves.toEqual({
      id: '/dist/runtime/components/JsxComponent.jsx',
      external: true,
    })
    const resolveId = runtimeExternals({ ...directories(), packageName: 'my-module', preserveJsx: () => false }).resolveId as (this: unknown, id: string, importer?: string) => Promise<unknown>
    await expect(resolveId.call({}, 'my-module/runtime/components/JsxComponent', importer)).resolves.toEqual({
      id: '/dist/runtime/components/JsxComponent.js',
      external: true,
    })
  })

  it('should point self-referencing runtime imports at their output, treating a `.client` suffix as part of the name and a directory as its index', async () => {
    await expect(createResolver('my-module')('my-module/runtime/plugins/plugin')).resolves.toEqual({
      id: '/dist/runtime/plugins/plugin.js',
      external: true,
    })
    await expect(createResolver('my-module')('my-module/runtime/plugins/plugin.client')).resolves.toEqual({
      id: '/dist/runtime/plugins/plugin.client.js',
      external: true,
    })
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-'))
    try {
      await mkdir(join(dir, 'utils'))
      await writeFile(join(dir, 'utils/index.ts'), 'export {}\n')
      const resolveId = runtimeExternals({ ...directories(dir), packageName: 'my-module' }).resolveId as (this: unknown, id: string, importer?: string) => Promise<unknown>
      await expect(resolveId.call({}, 'my-module/runtime/utils', importer)).resolves.toEqual({
        id: '/dist/runtime/utils/index.js',
        external: true,
      })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should ignore specifiers and files outside the runtime tree', async () => {
    await expect(createResolver('my-module')('@nuxt/kit')).resolves.toBeUndefined()
    const resolveId = runtimeExternals(directories()).resolveId as (this: unknown, id: string, importer?: string) => Promise<unknown>
    const context = { resolve: async () => ({ id: join(runtimeSrcDir, '../utils.ts'), external: false }) }
    await expect(resolveId.call(context, './utils', importer)).resolves.toBeUndefined()
  })

  it('should import runtime files relative to the chunk that imports them', () => {
    const renderChunk = runtimeExternals(directories()).renderChunk as (code: string, chunk: { fileName: string, imports: string[], dynamicImports: string[] }, options: { dir?: string }) => { code: string } | undefined
    const code = 'import plugin from "/dist/runtime/plugins/plugin.js";\nconst lazy = () => import("/dist/runtime/lazy.js");\nconst path = "/dist/runtime/plugins/plugin.js/other";\n'
    const chunk = (fileName: string) => ({ fileName, imports: ['/dist/runtime/plugins/plugin.js'], dynamicImports: ['/dist/runtime/lazy.js'] })
    expect(renderChunk(code, chunk('module.mjs'), { dir: '/dist' })?.code).toContain('from "./runtime/plugins/plugin.js"')
    expect(renderChunk(code, chunk('nested/helper.mjs'), { dir: '/dist' })?.code).toBe(code
      .replace('"/dist/runtime/plugins/plugin.js"', '"../runtime/plugins/plugin.js"')
      .replace('"/dist/runtime/lazy.js"', '"../runtime/lazy.js"'))
    const dotted = runtimeExternals({ outDir: '/dist', directories: [{ srcDir: runtimeSrcDir, outDir: '/dist/.runtime', ext: 'js' }] }).renderChunk as typeof renderChunk
    expect(dotted('import plugin from "/dist/.runtime/plugin.js";\n', { fileName: 'module.mjs', imports: ['/dist/.runtime/plugin.js'], dynamicImports: [] }, { dir: '/dist' })?.code).toBe('import plugin from "./.runtime/plugin.js";\n')
  })
})

describe('upgrade guide', () => {
  it('should have a heading for every section that diagnostics link to', async () => {
    const anchors = await guideAnchors()
    const links = Object.entries({ ...errorCodes, ...warningCodes }).flatMap(([code, { docs }]) => docs ? [[code, docs] as const] : [])
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter(([, docs]) => !docs.startsWith('#') || !anchors.includes(docs.slice(1)))).toEqual([])
  })

  it('should link diagnostics to the guide at the release tag of this version', () => {
    expect(GUIDE_URL).toBe(`https://github.com/nuxt/module-builder/blob/v${version}/docs/upgrade-v2.md`)
    expect(errors.NUXT_MB_C0004().docs).toBe(`${GUIDE_URL}#tsdown-config`)
    expect(errors.NUXT_MB_D0004({ options: [{ option: 'stub', section: 'stub-builds' }] }).message).toContain(`(${GUIDE_URL}#stub-builds)`)
  })
})

describe('install commands in the docs', () => {
  it('should install a range of `@nuxt/module-builder` that includes this version', async () => {
    const docsDir = fileURLToPath(new URL('../docs', import.meta.url))
    const files = [fileURLToPath(new URL('../README.md', import.meta.url)), ...(await readdir(docsDir)).filter(file => file.endsWith('.md')).map(file => join(docsDir, file))]
    const ranges: Array<[file: string, range: string | undefined]> = []
    for (const file of files) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (/\b(?:pnpm|npm|yarn|bun) (?:add|install|i)\b.*@nuxt\/module-builder\b/.test(line)) {
          ranges.push([basename(file), line.match(/@nuxt\/module-builder@([^\s`]+)/)?.[1]])
        }
        const dependency = line.match(/"@nuxt\/module-builder": "([~^][^"]+)"/)?.[1]
        if (dependency) {
          ranges.push([basename(file), dependency])
        }
      }
    }
    expect(ranges.length).toBeGreaterThan(3)
    const prerelease = version.includes('-')
    expect(ranges.filter(([, range]) => !range || !satisfies(version, range) || range.includes('-') !== prerelease)).toEqual([])
  })
})

describe('command docs', () => {
  const commands = { build: buildCommand, prepare: prepareCommand }

  function documentedOptions(markdown: string, command: string) {
    const section = markdown.split(/^## /m).find(section => section.startsWith(`\`${command}\`\n`))!
    const options = section.split(/^### Options$/m)[1]!.split(/^#/m)[0]!
    return Object.fromEntries([...options.matchAll(/^\| `--(\w+)(?:=[^`]*)?` \| (?:`([^`]*)`)? *\|/gm)].map(([, name, value]) => [name, value ?? '']))
  }

  it.each(['docs/2.commands.md', 'docs/cli/build-module/index.md'])('should list the options of each command in %s', async (file) => {
    const markdown = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
    for (const [name, command] of Object.entries(commands)) {
      const args = Object.entries(command.args!).filter(([, arg]) => arg.type !== 'positional')
      expect(documentedOptions(markdown, name)).toEqual(Object.fromEntries(args.map(([key, arg]) => [key, arg.default === undefined ? '' : String(arg.default)])))
    }
  })
})

describe('hints', () => {
  it('should suggest installing the peer range of tsdown when it is missing', () => {
    expect(errors.NUXT_MB_B0003().fix).toMatch(/pnpm add -D tsdown@"\^[\d.]+"`\.$/)
  })

  it('should give a thrown diagnostic its fix and docs as its stack, and unwrap it from a build error with the stack of its cause', () => {
    const plain = errors.NUXT_MB_C0004()
    expect(plain.stack).toBe([
      `NUXT_MB_C0004: ${plain.message}`,
      '├▶ fix: Call `builder()` in each config that builds the module.',
      `╰▶ see: ${GUIDE_URL}#tsdown-config`,
    ].join('\n'))
    const cause = new Error('boom')
    const caused = errors.NUXT_MB_B0002({ file: 'dist/module.mjs', reason: 'boom', cause })
    expect(unwrapBuildError({ errors: [caused] })).toBe(caused)
    expect(caused.stack).toMatch(/^NUXT_MB_B0002: [^\n]+\n╰▶ fix: [^\n]+\nCaused by: Error: boom\n {4}at /)
    const both = { errors: [plain, caused] }
    expect(unwrapBuildError(both)).toBe(both)
    expect(unwrapBuildError(plain)).toBe(plain)
  })
})

describe('findModuleCodeIssues', () => {
  const list = (found: ModuleCodeIssue[]) => found.map(({ file, line, column, importedBy, message }) => `${file}:${line}:${column}${importedBy ? ` (imported by ${importedBy})` : ''}: ${message}`)

  it('should only list namespaces that contain runtime code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-namespaces-'))
    try {
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'src/module.ts'), [
        `export namespace Types {`,
        `  export type Value = string`,
        `  export interface Options { value: Value }`,
        `  export namespace Nested { export type Flag = boolean }`,
        `}`,
        `export namespace Runtime {`,
        `  export const value = 1`,
        `}`,
        `export namespace Deep.Inner { export const value = 2 }`,
        ``,
      ].join('\n'))
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], []))).toEqual([
        expect.stringMatching(/^src\/module\.ts:6:1: `namespace`/),
        expect.stringMatching(/^src\/module\.ts:9:1: `namespace`/),
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should list syntax Node cannot strip, tsconfig `paths` aliases and Nuxt app aliases across the imported sources, with their fixes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-erasable-'))
    try {
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '~/*': ['./*'] } } }))
      await writeFile(join(dir, 'src/module.ts'), [
        `import { Level } from './levels'`,
        `import {`,
        `  asArray,`,
        `  normalise,`,
        `} from './util'`,
        `import { Context } from '~/src/context'`,
        `import type { Unused } from './types'`,
        `export * from './shared'`,
        ``,
        `export class Holder {`,
        `  constructor(public value: string, private flag = false) {}`,
        `}`,
        `export const level = <string>Level.High`,
        `export declare enum Ambient { A }`,
        `export { asArray, normalise, Context }`,
        `export { useNuxtApp } from '#app'`,
        `export type { NuxtApp } from '#app'`,
        ``,
      ].join('\n'))
      await writeFile(join(dir, 'src/levels.ts'), `export enum Level { High = 'high' }\n`)
      await writeFile(join(dir, 'src/util.ts'), `export const asArray = (v: unknown) => <unknown[]>(Array.isArray(v) ? v : [v])\nexport function normalise(v: string) {\n  return <string>v.trim()\n}\n`)
      await writeFile(join(dir, 'src/context.ts'), `export class Context {\n  constructor(\n    public readonly name: string,\n    public options: object,\n  ) {}\n}\n`)
      await writeFile(join(dir, 'src/shared.ts'), `export const enum Mode { On }\n`)
      await writeFile(join(dir, 'src/types.ts'), `export interface Unused { never: true }\ndeclare module 'ambient' { enum Hidden { A } }\nexport enum Skipped { A }\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], []))).toEqual([
        'src/context.ts:3:5: parameter property (declare the field and assign it in the constructor)',
        'src/context.ts:4:5: parameter property (declare the field and assign it in the constructor)',
        'src/levels.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
        'src/module.ts:1:23: `./levels` (use `./levels.ts`)',
        'src/module.ts:5:8: `./util` (use `./util.ts`)',
        'src/module.ts:6:25: `~/src/context` is a tsconfig `paths` alias (use `./context.ts`, or an entry in the `imports` of `package.json`)',
        'src/module.ts:8:15: `./shared` (use `./shared.ts`)',
        'src/module.ts:11:15: parameter property (declare the field and assign it in the constructor)',
        'src/module.ts:11:37: parameter property (declare the field and assign it in the constructor)',
        'src/module.ts:13:22: angle-bracket type assertion (write `value as Type`)',
        'src/module.ts:16:28: `#app` only exists in a Nuxt app (move the code that uses it into a runtime file the module adds, or import types only)',
        'src/shared.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
        'src/util.ts:1:40: angle-bracket type assertion (write `value as Type`)',
        'src/util.ts:3:10: angle-bracket type assertion (write `value as Type`)',
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should list relative value imports Node cannot resolve as written, including in the runtime files module code imports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-extensions-'))
    try {
      await mkdir(join(dir, 'src/kit'), { recursive: true })
      await mkdir(join(dir, 'src/runtime'), { recursive: true })
      await mkdir(join(dir, 'node_modules/fake-pkg'), { recursive: true })
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '~/*': ['./*'], '*': ['./src/*'] } } }))
      await writeFile(join(dir, 'node_modules/fake-pkg/package.json'), JSON.stringify({ name: 'fake-pkg', main: 'index.js' }))
      await writeFile(join(dir, 'node_modules/fake-pkg/index.js'), `module.exports = {}\n`)
      await writeFile(join(dir, 'src/fake-pkg.ts'), `import { shadow } from './shadow'\nexport { shadow }\n`)
      await writeFile(join(dir, 'src/shadow.ts'), `export const shadow = 1\n`)
      await writeFile(join(dir, 'src/module.ts'), [
        `import { kit } from './kit'`,
        `import { util } from './util.js'`,
        `import { ok } from './ok.ts'`,
        `import { aliased } from '~/src/aliased'`,
        `import type { Shape } from './shape'`,
        `import plugin from './runtime/plugin'`,
        `import { legacy } from './legacy.js'`,
        `import pkg from 'fake-pkg'`,
        `export { more } from './more'`,
        `export type { Shape } from './shape'`,
        `export const load = () => import('./lazy')`,
        `export { kit, util, ok, aliased, plugin, legacy, pkg }`,
        `export type { Shape }`,
      ].join('\n'))
      await writeFile(join(dir, 'src/kit/index.ts'), `export const kit = 1\n`)
      await writeFile(join(dir, 'src/util.ts'), `export const util = 1\n`)
      await writeFile(join(dir, 'src/ok.ts'), `import { nested } from './nested'\nexport const ok = nested\n`)
      await writeFile(join(dir, 'src/nested.ts'), `export const nested = 1\n`)
      await writeFile(join(dir, 'src/aliased.ts'), `import { deep } from '../deep'\nexport const aliased = deep\n`)
      await writeFile(join(dir, 'deep.ts'), `export const deep = 1\n`)
      await writeFile(join(dir, 'src/shape.ts'), `export interface Shape { a: 1 }\n`)
      await writeFile(join(dir, 'src/runtime/plugin.ts'), `import { helper } from './helper'\nimport { shared } from '../shared'\nexport default [helper, shared]\n`)
      await writeFile(join(dir, 'src/shared.ts'), `import { tail } from './tail'\nexport const shared = tail\n`)
      await writeFile(join(dir, 'src/tail.ts'), `export const tail = 1\n`)
      await writeFile(join(dir, 'src/runtime/helper.ts'), `export const helper = 1\n`)
      await writeFile(join(dir, 'src/more.ts'), `export const more = 1\n`)
      await writeFile(join(dir, 'src/legacy.js'), `export * from './leaf'\nexport const legacy = 1\n`)
      await writeFile(join(dir, 'src/leaf.ts'), `export const leaf = 1\n`)
      await writeFile(join(dir, 'src/lazy.ts'), `export const lazy = 1\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], [join(dir, 'src/runtime')]))).toEqual([
        'src/aliased.ts:1:22: `../deep` (use `../deep.ts`)',
        'src/legacy.js:1:15: `./leaf` (use `./leaf.ts`)',
        'src/module.ts:1:21: `./kit` (use `./kit/index.ts`)',
        'src/module.ts:2:22: `./util.js` (use `./util.ts`)',
        'src/module.ts:4:25: `~/src/aliased` is a tsconfig `paths` alias (use `./aliased.ts`, or an entry in the `imports` of `package.json`)',
        'src/module.ts:6:20: `./runtime/plugin` (use `./runtime/plugin.ts`)',
        'src/module.ts:9:22: `./more` (use `./more.ts`)',
        'src/module.ts:11:34: `./lazy` (use `./lazy.ts`)',
        'src/ok.ts:1:24: `./nested` (use `./nested.ts`)',
        'src/runtime/plugin.ts:1:24 (imported by src/module.ts:6): `./helper` (use `./helper.ts`)',
        'src/runtime/plugin.ts:2:24 (imported by src/module.ts:6): `../shared` (use `../shared.ts`)',
        'src/shared.ts:1:22: `./tail` (use `./tail.ts`)',
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should list value imports of single-file components, JSX and JSON without an import attribute', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-unloadable-'))
    try {
      await mkdir(join(dir, 'src/runtime'), { recursive: true })
      await writeFile(join(dir, 'src/module.ts'), [
        `import Card from './runtime/Card.vue'`,
        `import type CardType from './runtime/Card.vue'`,
        `import { label } from './runtime/label'`,
        `import data from './data.json'`,
        `import options from './options.json' with { type: 'json' }`,
        `const empty = await import('./data.json', {})`,
        `const loaded = await import('./options.json', { with: { type: 'json' } })`,
        `const type = 'json'`,
        `const shorthand = await import('./options.json', { with: { type } })`,
        `const extra = { with: { type: 'json' } }`,
        `const spread = await import('./options.json', { with: {}, ...extra })`,
        `const overridden = await import('./data.json', { ...extra, with: {} })`,
        `export const refs = [Card, label, data, options, empty, loaded, shorthand, spread, overridden]`,
        `export type { CardType }`,
        ``,
      ].join('\n'))
      await writeFile(join(dir, 'src/runtime/Card.vue'), `<template><div /></template>\n`)
      await writeFile(join(dir, 'src/runtime/label.tsx'), `export const label = <span />\n`)
      await writeFile(join(dir, 'src/data.json'), `{}\n`)
      await writeFile(join(dir, 'src/options.json'), `{}\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], [join(dir, 'src/runtime')]))).toEqual([
        'src/module.ts:1:18: `./runtime/Card.vue` is a single-file component, which Node cannot load (move the value the module needs into a `.ts` file, or use `import type`)',
        'src/module.ts:3:23: `./runtime/label` is JSX, which Node cannot load (move the value the module needs into a `.ts` file, or use `import type`)',
        'src/module.ts:4:18: `./data.json` is JSON (use `import pkg from \'./data.json\' with { type: \'json\' }` and read `pkg.version`; destructuring `pkg` bundles the whole file)',
        'src/module.ts:6:28: `./data.json` is JSON (use `import pkg from \'./data.json\' with { type: \'json\' }` and read `pkg.version`; destructuring `pkg` bundles the whole file)',
        'src/module.ts:12:33: `./data.json` is JSON (use `import pkg from \'./data.json\' with { type: \'json\' }` and read `pkg.version`; destructuring `pkg` bundles the whole file)',
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should follow the `import` condition of the `imports` of `package.json`', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-conditional-imports-'))
    try {
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', imports: { '#helper': { import: './src/esm.ts', require: './src/cjs.cjs' }, '#external': { import: 'external', require: './src/legacy.ts' }, '#sync': { 'module-sync': './src/sync.ts', 'default': './src/legacy.ts' }, '#addons': { 'node-addons': './src/addons.ts', 'default': './src/legacy.ts' } } }))
      await writeFile(join(dir, 'src/module.ts'), `export { Mode } from '#helper'\nexport { value } from '#external'\nexport { Sync } from '#sync'\nexport { Addons } from '#addons'\n`)
      await writeFile(join(dir, 'src/sync.ts'), `export enum Sync { On }\n`)
      await writeFile(join(dir, 'src/addons.ts'), `export enum Addons { On }\n`)
      await writeFile(join(dir, 'src/esm.ts'), `export enum Mode { On }\n`)
      await writeFile(join(dir, 'src/cjs.cjs'), `exports.Mode = { On: 0 }\n`)
      await writeFile(join(dir, 'src/legacy.ts'), `export enum Legacy { On }\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], []))).toEqual([
        'src/addons.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
        'src/esm.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
        'src/sync.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should only report the tsconfig `paths` aliases of an installed package with only an `import` condition that it does not export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-import-only-'))
    try {
      await mkdir(join(dir, 'src'))
      await mkdir(join(dir, 'node_modules/esm-only'), { recursive: true })
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { 'esm-only': ['./src/esm-only.ts'], 'esm-only/local': ['./src/local.ts'] } } }))
      await writeFile(join(dir, 'node_modules/esm-only/package.json'), JSON.stringify({ name: 'esm-only', type: 'module', exports: { '.': { import: './index.js' } } }))
      await writeFile(join(dir, 'node_modules/esm-only/index.js'), `export const value = 1\n`)
      await writeFile(join(dir, 'src/esm-only.ts'), `export const value = 1\n`)
      await writeFile(join(dir, 'src/local.ts'), `export const local = 1\n`)
      await writeFile(join(dir, 'src/module.ts'), `import { value } from 'esm-only'\nimport { local } from 'esm-only/local'\nexport default value + local\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], []))).toEqual([
        expect.stringMatching(/^src\/module\.ts:2:23: `esm-only\/local` is a tsconfig `paths` alias/),
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should follow the `imports` of `package.json` into the module\'s sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-imports-'))
    try {
      await mkdir(join(dir, 'src/internal'), { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', imports: { '#internal/*': './src/internal/*.ts' } }))
      await writeFile(join(dir, 'src/module.ts'), `import { helper } from '#internal/helper'\nexport default helper\n`)
      await writeFile(join(dir, 'src/internal/helper.ts'), `import { value } from './value'\nexport const helper = value\n`)
      await writeFile(join(dir, 'src/internal/value.ts'), `export const value = 1\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], []))).toEqual([
        'src/internal/helper.ts:1:23: `./value` (use `./value.ts`)',
      ])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('deprecation checks', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))

  it('should warn about referenced `.d.ts` output that is no longer generated', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(checkLegacyDeclarationPaths(cwd, { exports: { '.': { types: './dist/module.d.ts' } } })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(reported('NUXT_MB_D0104', '`./dist/module.d.ts`'))
    warn.mockClear()
    expect(checkLegacyDeclarationPaths(cwd, { exports: { '.': './dist/module.mjs' } })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('should refuse published paths that point at TypeScript sources or that the pack leaves out', () => {
    const pkg = {
      files: ['dist'],
      exports: { '.': { types: './.nuxt/module-builder/types.d.mts', default: './src/module.ts' }, './utils': './src/utils.ts' },
      imports: { '#shared/*': './src/runtime/shared/*.ts', '#dep': 'some-dependency' },
      types: './src/module.d.ts',
      publishConfig: {
        exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' } },
        imports: { '#shared/*': './dist/runtime/shared/*.js', '#dep': 'some-dependency' },
      },
    }
    expect(unpublishablePathsError(cwd, pkg)).toEqual(diagnostic('NUXT_MB_C0101', 'Pointing at paths that the pack leaves out: `types` (`./src/module.d.ts`).'))
    expect(unpublishablePathsError(cwd, pkg)?.message).not.toContain('Pointing at TypeScript sources')
    expect(unpublishablePathsError(cwd, { ...pkg, publishConfig: { ...pkg.publishConfig, types: './dist/types.d.mts' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { ...pkg, publishConfig: undefined })).toEqual(diagnostic('NUXT_MB_C0101', 'Pointing at TypeScript sources, which Node does not load from `node_modules`: `exports` (`./src/module.ts`, `./src/utils.ts`). Pointing at paths that the pack leaves out: `exports`, `types` (`./.nuxt/module-builder/types.d.mts`, `./src/module.d.ts`).'))
    expect(unpublishablePathsError(cwd, { files: ['dist', 'src/module.ts'], main: './src/module.ts' })).toEqual(diagnostic('NUXT_MB_C0101', 'Pointing at TypeScript sources, which Node does not load from `node_modules`: `main` (`./src/module.ts`)'))
  })

  it('should refuse published `imports` that point at TypeScript sources or that the pack leaves out only when the build output imports them', () => {
    const pkg = { files: ['dist', '.nuxt/ui.static.css'], imports: { '#internal/*': './src/internal/*.ts', '#shared': './shared/index.js', '#build/ui.css': './.nuxt/ui.static.css', '#dep': 'some-dependency' } }
    expect(unpublishablePathsError(cwd, pkg)).toBeUndefined()
    expect(unpublishableImportsError(cwd, pkg, () => false)).toBeUndefined()
    expect(unpublishableImportsError(cwd, pkg, () => true)).toEqual(diagnostic('NUXT_MB_C0102', 'Pointing at TypeScript sources, which Node does not load from `node_modules`: `#internal/*` (`./src/internal/*.ts`). Pointing at paths that the pack leaves out: `#shared` (`./shared/index.js`).'))
    expect(unpublishableImportsError(cwd, pkg, key => key === '#shared')?.message).not.toContain('#internal')
    const publishConfig: Record<string, unknown> = { imports: { '#internal/*': './dist/internal/*.mjs', '#shared': './dist/shared.mjs' } }
    expect(unpublishableImportsError(cwd, { ...pkg, publishConfig }, () => true)).toBeUndefined()
  })

  it('should resolve a package import to the `imports` key that Node picks', () => {
    const keys = ['#internal/*', '#internal/public', '#internal/nested/*', '#styles/*.css']
    expect(importsKeyFor(keys, '#internal/public')).toBe('#internal/public')
    expect(importsKeyFor(keys, '#internal/value')).toBe('#internal/*')
    expect(importsKeyFor(keys, '#internal/nested/value')).toBe('#internal/nested/*')
    expect(importsKeyFor(keys, '#styles/main.css')).toBe('#styles/*.css')
    expect(importsKeyFor(keys, '#styles/main.js')).toBeUndefined()
  })

  it('should accept published paths that `files` lists, and `main`, which every pack includes', () => {
    expect(unpublishablePathsError(cwd, { files: ['dist', '.nuxt/ui.static.css'], imports: { '#build/ui.css': './.nuxt/ui.static.css' }, exports: { '.': './dist/module.mjs' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['./dist/', 'lib/*.js'], main: './index.js', exports: { '.': './dist/module.mjs', './lib': './lib/a.js', './runtime/*': './dist/runtime/*' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist/**/*.mjs'], exports: { './runtime/*': './dist/runtime/*' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { exports: { '.': './dist/module.mjs', './types': './types/index.d.ts' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist'], main: './index.mjs', exports: { '.': './index.mjs', './package.json': './package.json' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist', '!dist/private'], exports: { './private': './dist/private/a.mjs' } })).toEqual(diagnostic('NUXT_MB_C0101', '(`./dist/private/a.mjs`)'))
    expect(unpublishablePathsError(cwd, { files: ['dist', '!dist/private'], exports: { './private/*': './dist/private/*' } })).toEqual(diagnostic('NUXT_MB_C0101', '(`./dist/private/*`)'))
    expect(unpublishablePathsError(cwd, { files: ['dist/module.mjs', 'dist/runtime/*.d.ts'], exports: { './runtime/*': './dist/runtime/*.js' } })).toEqual(diagnostic('NUXT_MB_C0101', '(`./dist/runtime/*.js`)'))
    expect(unpublishablePathsError(cwd, { files: ['dist/module.mjs', 'dist/runtime/**/*.js'], exports: { './runtime/*': './dist/runtime/*.js' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist/**/*.[cm]js', 'dist/**/*.d.mts'], exports: { './runtime': './dist/runtime/index.mjs' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist/**/*.[!m]js'], exports: { './runtime': './dist/runtime/index.mjs' } })).toEqual(diagnostic('NUXT_MB_C0101', '(`./dist/runtime/index.mjs`)'))
    expect(unpublishablePathsError(cwd, { files: ['{dist,lib}'], exports: { './a': './lib/a.js', './b': './other/b.js' } })).toEqual(diagnostic('NUXT_MB_C0101', '(`./other/b.js`)'))
    expect(unpublishablePathsError(cwd, { exports: { '.': './.nuxt/module.mjs' } })).toEqual(diagnostic('NUXT_MB_C0101', 'paths that the pack leaves out: `exports` (`./.nuxt/module.mjs`)'))
  })

  it('should warn about referenced `module.cjs` output that is no longer generated', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(checkLegacyCJSPaths(cwd, { main: './dist/module.cjs' })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(reported('NUXT_MB_D0105'))
    warn.mockClear()
    expect(checkLegacyCJSPaths(cwd, { main: './dist/module.mjs' })).toBe(false)
    expect(checkLegacyCJSPaths(cwd, { main: './dist/submodule.cjs' })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('should warn about other referenced paths the build did not produce', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-paths-'))
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist/module.mjs'), '')
    await writeFile(join(root, 'package.json'), '{}')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const pkg = {
      types: './dist/stale.d.ts',
      main: './dist/module.cjs',
      exports: {
        '.': { types: './dist/types.d.ts', import: './dist/module.mjs' },
        './runtime/*': './dist/runtime/*',
        './utils': { types: './dist/utils.d.mts', import: './dist/utils.mjs' },
        './package.json': './package.json',
      },
    }
    expect(checkMissingPaths(root, pkg)).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(reported('NUXT_MB_C0203', ': `./dist/utils.d.mts`, `./dist/utils.mjs`.\n'))
    warn.mockClear()
    expect(checkMissingPaths(root, { exports: { '.': './dist/module.mjs', './package.json': './package.json' } })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    await rm(root, { recursive: true, force: true })
  })

  it('should warn about extensionless `typesVersions` paths that node10 resolution cannot probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-node10-'))
    await mkdir(join(root, 'dist/nested'), { recursive: true })
    for (const file of ['dist/util.d.mts', 'dist/util.mjs', 'dist/nested/index.d.mts', 'dist/legacy.d.ts', 'dist/gone.mjs']) {
      await writeFile(join(root, file), '')
    }
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const pkg = {
      exports: { './util': './dist/util.mjs', './gone': './dist/gone.mjs' },
      typesVersions: { '*': { 'util': ['dist/util'], 'nested': ['./dist/nested'], 'legacy': ['dist/legacy'], 'gone': ['dist/gone'], 'runtime/*': ['dist/runtime/*'] } },
    }
    expect(checkNode10DeclarationPaths(root, pkg)).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(reported('NUXT_MB_C0202', ': `dist/util`, `./dist/nested`.\n├▶ fix: Write each path with its extension: `./dist/util.d.mts` for `dist/util`, `./dist/nested/index.d.mts` for `./dist/nested`.'))
    warn.mockClear()
    expect(checkMissingPaths(root, pkg)).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(reported('NUXT_MB_C0203', ': `dist/gone`.\n'))
    warn.mockClear()
    expect(checkNode10DeclarationPaths(root, { typesVersions: { '*': { util: ['dist/util.d.mts'], legacy: ['dist/legacy'] } } })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    await rm(root, { recursive: true, force: true })
  })

  it('should warn about a stale `types` field', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(checkStaleTypesField(cwd, { types: './dist/nope.d.ts' })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(reported('NUXT_MB_C0201', '`./dist/nope.d.ts`'))
    warn.mockClear()
    expect(checkStaleTypesField(cwd, {})).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('should link the files a warning names that exist, and its docs, where the terminal supports hyperlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-links-'))
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'dist/util.d.mts'), '')
    vi.stubEnv('FORCE_HYPERLINK', '1')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      expect(checkNode10DeclarationPaths(root, { typesVersions: { '*': { util: ['dist/util'] } } })).toBe(true)
      const message = String(warn.mock.calls[0]![0])
      const link = (url: string, label: string) => `\x1B]8;;${url}\x07${label}\x1B]8;;\x07`
      expect(message).toContain(link(pathToFileURL(join(root, 'package.json')).href, 'package.json'))
      expect(message).toContain(link(pathToFileURL(join(root, 'dist/util.d.mts')).href, './dist/util.d.mts'))
      expect(message).toContain(`${GUIDE_URL}#typesversions-paths\x07`)
      expect(message).not.toContain(pathToFileURL(join(root, 'dist/util')).href + '\x07')
    }
    finally {
      warn.mockRestore()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('should link the directories and tsconfig that the note about unchecked files names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-unchecked-'))
    await mkdir(join(root, 'test'))
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(join(root, 'vitest.config.ts'), '')
    vi.stubEnv('FORCE_HYPERLINK', '1')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    try {
      warnings.NUXT_MB_C0303({ groups: [['test/', 2], ['vitest.config.ts', 1]], sources: [`${join(root, 'test')}/`, join(root, 'vitest.config.ts'), join(root, 'tsconfig.json')] }, { method: 'info' })
      const message = String(info.mock.calls[0]![0])
      const link = (url: string, label: string) => `\x1B]8;;${url}\x07${label}\x1B]8;;\x07`
      expect(message).toContain(link(pathToFileURL(join(root, 'test')).href, 'test/'))
      expect(message).toContain(link(pathToFileURL(join(root, 'vitest.config.ts')).href, 'vitest.config.ts'))
      expect(message).toContain(link(pathToFileURL(join(root, 'tsconfig.json')).href, 'tsconfig.json'))
    }
    finally {
      info.mockRestore()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('should dim the code, show inline code in cyan and link paths outside the module where the terminal supports it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-styles-'))
    await mkdir(join(root, 'mod/.nuxt'), { recursive: true })
    await writeFile(join(root, 'tsconfig.json'), '{}')
    await writeFile(join(root, 'mod/.nuxt/tsconfig.json'), '{}')
    await writeFile(join(root, 'mod/.nuxt/tsconfig.app.json'), '{}')
    vi.stubEnv('FORCE_COLOR', '1')
    vi.stubEnv('FORCE_HYPERLINK', '1')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    try {
      warnings.NUXT_MB_C0301({ path: '../tsconfig.json', inside: false, sources: [join(root, 'tsconfig.json'), join(root, 'mod/.nuxt/tsconfig.json'), join(root, 'mod/.nuxt/tsconfig.app.json')] }, { method: 'info' })
      const message = String(info.mock.calls[0]![0])
      const link = (file: string, label: string) => `\x1B]8;;${pathToFileURL(file).href}\x07${label}\x1B]8;;\x07`
      expect(message.startsWith('\x1B[2m[NUXT_MB_C0301]\x1B[22m ')).toBe(true)
      expect(message).toContain(`\x1B[36m${link(join(root, 'tsconfig.json'), '../tsconfig.json')}\x1B[39m takes`)
      expect(message).toContain(link(join(root, 'mod/.nuxt/tsconfig.json'), '.nuxt/tsconfig.json'))
      expect(message).toContain(link(join(root, 'mod/.nuxt/tsconfig.app.json'), './.nuxt/tsconfig.app.json'))
      expect(message).not.toContain('`')
    }
    finally {
      info.mockRestore()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('sourcePathsPackError', () => {
  const cwd = '/mod'
  const pkg = {
    exports: { '.': { types: './.nuxt/module-builder/types.d.mts', default: './src/module.ts' }, './utils': './src/utils.ts' },
    imports: { '#shared/*': './src/runtime/shared/*.ts', '#dep': 'some-dependency' },
    main: './src/module.ts',
    types: './.nuxt/module-builder/types.d.mts',
    typesVersions: { '*': { utils: ['./dist/utils.d.mts'] } },
    publishConfig: {
      exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' }, './utils': './dist/utils.mjs' },
      imports: { '#shared/*': './dist/runtime/shared/*.js', '#dep': 'some-dependency' },
      main: './dist/module.mjs',
      types: './dist/types.d.mts',
    },
  }
  const pack = (agent: string, execpath: string, event = 'prepack') => ({ npm_lifecycle_event: event, npm_config_user_agent: `${agent} npm/? node/v24.21.0 linux arm64`, npm_execpath: execpath })
  const pnpm = pack('pnpm/12.11.2', '/home/me/.local/share/pnpm/12.11.2/pnpm')
  const npm = pack('npm/11.19.0', '/usr/lib/node_modules/npm/bin/npm-cli.js')
  const yarn = pack('yarn/4.18.1', '/tmp/xfs-73007f9c/yarn')
  const yarnClassic = pack('yarn/1.22.22', '/usr/lib/node_modules/yarn/bin/yarn.js')
  const bun = pack('bun/1.3.14', '/home/me/.bun/bin/bun')

  it('should pass packs that replace every source path from `publishConfig`', () => {
    expect(sourcePathsPackError(cwd, pkg, pnpm)).toBeUndefined()
    expect(sourcePathsPackError(cwd, pkg, { ...pnpm, npm_lifecycle_event: 'prepublishOnly' })).toBeUndefined()
    expect(sourcePathsPackError(cwd, pkg, yarn)).toBeUndefined()
    expect(sourcePathsPackError(cwd, publishedPackage(pkg), npm)).toBeUndefined()
  })

  it('should only check `prepack` and `prepublishOnly` scripts', () => {
    expect(sourcePathsPackError(cwd, pkg, { ...npm, npm_lifecycle_event: 'build' })).toBeUndefined()
    expect(sourcePathsPackError(cwd, pkg, {})).toBeUndefined()
  })

  it('should refuse packs by package managers that publish the source paths as written', () => {
    const paths = '`./.nuxt/module-builder/types.d.mts`, `./src/module.ts`, `./src/utils.ts`, `./src/runtime/shared/*.ts`'
    expect(sourcePathsPackError(cwd, pkg, npm)).toEqual(diagnostic('NUXT_MB_C0104', `\`npm@11.19.0\` packs these fields of \`package.json\` as written, and they point at TypeScript sources or paths that \`files\` leaves out: \`exports\`, \`imports\`, \`main\`, \`types\` (${paths}).`))
    expect(sourcePathsPackError(cwd, pkg, npm)?.fix).toContain('pack and publish with pnpm or Yarn 4')
    expect(sourcePathsPackError(cwd, pkg, { ...npm, npm_lifecycle_event: 'prepublishOnly' })).toEqual(diagnostic('NUXT_MB_C0104', '`npm@11.19.0` packs'))
    expect(sourcePathsPackError(cwd, pkg, yarnClassic)).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@1.22.22` packs'))
    expect(sourcePathsPackError(cwd, pkg, bun)).toEqual(diagnostic('NUXT_MB_C0104', '`bun@1.3.14` packs'))
    expect(sourcePathsPackError(cwd, pkg, { npm_lifecycle_event: 'prepack' })).toEqual(diagnostic('NUXT_MB_C0104', 'This package manager packs'))
  })

  it('should name the package manager that packs when a script of another one runs it', () => {
    expect(sourcePathsPackError(cwd, pkg, { ...npm, npm_config_user_agent: pnpm.npm_config_user_agent })).toEqual(diagnostic('NUXT_MB_C0104', '`npm` packs'))
    expect(sourcePathsPackError(cwd, pkg, { ...yarnClassic, npm_execpath: pnpm.npm_execpath })).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@1.22.22` packs'))
    expect(sourcePathsPackError(cwd, pkg, { ...yarnClassic, npm_execpath: npm.npm_execpath })).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@1.22.22` packs'))
    expect(sourcePathsPackError(cwd, pkg, { ...yarn, npm_execpath: npm.npm_execpath })).toEqual(diagnostic('NUXT_MB_C0104', '`npm` packs'))
  })

  it('should refuse source paths that `publishConfig` does not replace', () => {
    const { types: _, ...publishConfig } = pkg.publishConfig
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig }, pnpm)).toEqual(diagnostic('NUXT_MB_C0105', 'so they would be published as written: `types` (`./.nuxt/module-builder/types.d.mts`).'))
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig }, pnpm)?.fix).toBe('Set `publishConfig.types` to the `dist` paths.')
    expect(sourcePathsPackError(cwd, { exports: pkg.exports }, pnpm)?.fix).toBe('Set `publishConfig.exports` to the `dist` paths.')
  })

  it('should refuse `publishConfig` fields that point at sources', () => {
    const publishConfig = { ...pkg.publishConfig, main: './src/module.ts' }
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig }, pnpm)).toEqual(diagnostic('NUXT_MB_C0103', 'so they would be published that way: `main` (`./src/module.ts`).'))
    expect(sourcePathsPackError(cwd, { main: './dist/module.mjs', publishConfig: { main: './src/module.ts' } }, yarn)).toEqual(diagnostic('NUXT_MB_C0103'))
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig: { ...pkg.publishConfig, typesVersions: { '*': { utils: ['./src/utils.ts'] } } } }, yarn)).toBeUndefined()
    expect(sourcePathsPackError(cwd, { files: ['dist/*.d.mts'], main: './dist/module.mjs', exports: './src/module.ts', publishConfig: { exports: './dist/module.mjs' } }, pnpm)).toBeUndefined()
  })

  it('should refuse `typesVersions` that point at sources when Yarn packs', () => {
    const typesVersions = { '*': { utils: ['./src/utils.ts'] } }
    const sourceTypesVersions = { ...pkg, typesVersions, publishConfig: { ...pkg.publishConfig, typesVersions: { '*': { utils: ['./dist/utils.d.mts'] } } } }
    expect(sourcePathsPackError(cwd, sourceTypesVersions, pnpm)).toBeUndefined()
    expect(sourcePathsPackError(cwd, sourceTypesVersions, yarn)).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@4.18.1` packs these fields of `package.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `typesVersions` (`./src/utils.ts`).'))
    expect(sourcePathsPackError(cwd, sourceTypesVersions, yarn)?.fix).toContain('pack and publish with pnpm, which')
  })

  it('should refuse the fields that Yarn 2 and 3 pack as written', () => {
    const yarn2 = pack('yarn/2.4.2', '/tmp/xfs-b1b0ae8e/yarn')
    const yarn3 = pack('yarn/3.8.7', '/tmp/xfs-e94f6087/yarn')
    expect(sourcePathsPackError(cwd, pkg, yarn2)).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@2.4.2` packs these fields of `package.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `exports`, `imports`, `types` ('))
    expect(sourcePathsPackError(cwd, pkg, yarn3)).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@3.8.7` packs these fields of `package.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `types` (`./.nuxt/module-builder/types.d.mts`)'))
    expect(sourcePathsPackError(cwd, { main: pkg.main, publishConfig: { main: pkg.publishConfig.main } }, yarn2)).toBeUndefined()
    expect(sourcePathsPackError(cwd, pkg, pack('yarn/5.0.0', '/tmp/xfs-0/yarn'))).toEqual(diagnostic('NUXT_MB_C0104', '`yarn@5.0.0` packs'))
  })
})

describe('writeTypes', () => {
  it('should re-export every declaration and star re-export of `module.d.mts` as written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-types-'))
    await writeFile(join(dir, 'module.d.mts'), [
      'export declare abstract class Base {}',
      'export declare namespace Helpers { const x: number }',
      'export declare const a: string, b: number',
      'export declare const { c, d: [e] }: { c: 1, d: [2] }',
      `export * as ns from './ns.mjs'`,
      `export type * from './types.mjs'`,
      `export type { Options as ModuleOptions } from './options.mjs'`,
      `export { t as shared } from './chunk.mjs'`,
      `export { a as "kebab-name" }`,
      `export * from "./it's.mjs"`,
      `export * as "kebab-ns" from './kebab.mjs'`,
      'declare const _default: unknown',
      'export { _default as default }',
    ].join('\n'))
    await writeTypes(dir)
    expect((await readFile(join(dir, 'types.d.mts'), 'utf-8')).split('\n').filter(line => line.startsWith('export'))).toEqual([
      `export { a, b, Base, c, e, Helpers, "kebab-name", type ModuleOptions, shared, default } from './module.mjs'`,
      `export * as ns from './ns.mjs'`,
      `export type * from './types.mjs'`,
      `export * from './it\\'s.mjs'`,
      `export * as "kebab-ns" from './kebab.mjs'`,
    ])
    await rm(dir, { recursive: true, force: true })
  })
})

describe('writeSourceTypes', () => {
  it('should re-export the module entry and add its type augmentations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-source-types-'))
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'src/module.ts'), `export interface ModuleHooks {}\nexport default {}\n`)
    const dir = join(cwd, '.nuxt/module-builder')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'stale.d.mts'), '')
    await writeSourceTypes(dir, join(cwd, 'src/module.ts'))
    expect((await readdir(dir)).sort()).toEqual(['module.d.mts', 'types.d.mts'])
    expect(await readFile(join(dir, 'module.d.mts'), 'utf-8')).toBe(`export * from '../../src/module.js'\nexport { default } from '../../src/module.js'\n`)
    expect(await readFile(join(dir, 'types.d.mts'), 'utf-8')).toMatchInlineSnapshot(`
      "import type { NuxtModule } from '@nuxt/schema'

      import type { default as Module, ModuleHooks } from './module.mjs'

      declare module '@nuxt/schema' {
        interface NuxtHooks extends ModuleHooks {}
      }

      export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>
      export * from "./module.mjs"
      export { default } from "./module.mjs"
      "
    `)
    await rm(cwd, { recursive: true, force: true })
  })

  it('should write declarations that type-check, and augment every interface that a star re-export may export', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-source-types-'))
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'ambient.d.ts'), [
      `declare module '@nuxt/schema' {\n  interface NuxtHooks {}\n  interface RuntimeConfig {}\n  interface PublicRuntimeConfig {}\n  type NuxtModule<T> = { options?: T }\n}`,
      `declare module '#app' {\n  interface RuntimeNuxtHooks {}\n}`,
    ].join('\n'))
    const check = async (module: string, files: Record<string, string> = {}) => {
      for (const [file, contents] of Object.entries({ 'src/module.ts': module, ...files })) {
        await mkdir(dirname(join(cwd, file)), { recursive: true })
        await writeFile(join(cwd, file), contents)
      }
      await writeSourceTypes(join(cwd, '.nuxt/module-builder'), join(cwd, 'src/module.ts'))
      await writeFile(join(cwd, 'probe.ts'), `import type { NuxtHooks } from '@nuxt/schema'\nimport type { ModuleOptions } from './.nuxt/module-builder/types.mjs'\n\nexport const options: ModuleOptions = { key: 'value' }\nexport type Hook = NuxtHooks['my-module:init']\n`)
      const program = ts.createProgram([join(cwd, 'ambient.d.ts'), join(cwd, 'probe.ts')], { noEmit: true, strict: true, skipLibCheck: false, allowImportingTsExtensions: true, types: [], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ESNext })
      return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    }
    const module = `export interface ModuleHooks { 'my-module:init': () => void }\nexport default { options: { key: '' } } as { options?: { key: string } }\n`
    expect(await check(module)).toEqual([])
    expect(await check(`export * from './types.ts'\nexport default { options: { key: '' } } as { options?: { key: string } }\n`, {
      'src/types.ts': `export interface ModuleOptions { key: string }\nexport interface ModuleHooks { 'my-module:init': () => void }\nexport interface ModuleRuntimeHooks {}\nexport interface ModuleRuntimeConfig {}\nexport interface ModulePublicRuntimeConfig {}\n`,
    })).toEqual([])
    expect(await check(`export * from './helpers.ts'\n${module}`, {
      'src/helpers.ts': `export const helper = (): string => 'helper'\nexport default 'not re-exported'\n`,
    })).toEqual([])
    expect(await check(`export type * from './hooks.ts'\nexport default { options: { key: '' } } as { options?: { key: string } }\n`, {
      'src/hooks.ts': `export * from './nested/hooks.ts'\n`,
      'src/nested/hooks.ts': `export interface ModuleHooks { 'my-module:init': () => void }\n`,
    })).toEqual([])
    expect(await check(`export type * from './declared'\nexport default { options: { key: '' } } as { options?: { key: string } }\n`, {
      'src/declared.d.ts': `export interface ModuleHooks { 'my-module:init': () => void }\n`,
    })).toEqual([])
    expect(await check(`export type * from './siblings.mjs'\nexport default { options: { key: '' } } as { options?: { key: string } }\n`, {
      'src/siblings.d.mts': `export interface ModuleHooks { 'my-module:init': () => void }\n`,
      'src/siblings.d.ts': `export interface ModuleRuntimeConfig { secret: string }\n`,
    })).toEqual([])
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('isolatedDeclarations nudge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  const loadShouldNudge = async () => (await import('../src/build/build.ts')).shouldNudge

  it('should nudge at most once per process', async () => {
    vi.stubEnv('CI', undefined)
    const shouldNudge = await loadShouldNudge()
    expect(shouldNudge(false)).toBe(true)
    expect(shouldNudge(false)).toBe(false)
  })

  it('should stay silent in CI', async () => {
    vi.stubEnv('CI', 'true')
    const shouldNudge = await loadShouldNudge()
    expect(shouldNudge(false)).toBe(false)
  })

  it('should stay silent when isolated declarations are already enabled', async () => {
    vi.stubEnv('CI', undefined)
    const shouldNudge = await loadShouldNudge()
    expect(shouldNudge(true)).toBe(false)
  })
})

describe('selfReferencePaths', () => {
  it('should map the package name and its export subpaths to source', () => {
    const exports = {
      '.': { types: './dist/types.d.mts', default: './dist/module.mjs' },
      './utils': './dist/utils.mjs',
      './runtime/*': './dist/runtime/*',
      './package.json': './package.json',
    }
    expect(selfReferencePaths('/mod', { name: 'my-module', exports }, '/mod/dist')).toEqual({
      'my-module': ['/mod/src/module'],
      'my-module/utils': ['/mod/src/utils'],
      'my-module/runtime/*': ['/mod/src/runtime/*'],
    })
  })

  it('should map a subpath to the input of the entry with that name', () => {
    const pkg = { name: 'my-module', exports: { './vite': './dist/vite.mjs', './utils': './dist/utils.mjs' } }
    expect(selfReferencePaths('/mod', pkg, '/mod/dist', { module: './src/module.ts', vite: './src/lib/vite.ts' })).toEqual({
      'my-module': ['/mod/src/module'],
      'my-module/vite': ['/mod/src/lib/vite'],
      'my-module/utils': ['/mod/src/utils'],
    })
  })
})

describe('importModule', () => {
  it('should import files in the output directory afresh for each version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-versions-'))
    await mkdir(join(root, 'out/runtime'), { recursive: true })
    await writeFile(join(root, 'out/module.mjs'), `export { name } from './runtime/name.js'\n`)
    await writeFile(join(root, 'out/runtime/name.js'), `export const name = 'one'\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const options = JSON.stringify({ cwd: root })
    const script = [
      `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)})`,
      `const { writeFile } = await import('node:fs/promises')`,
      `const first = await importModule(${JSON.stringify(join(root, 'out/module.mjs'))}, { ...${options}, version: 1 })`,
      `await writeFile(${JSON.stringify(join(root, 'out/runtime/name.js'))}, "export const name = 'two'\\n")`,
      `const second = await importModule(${JSON.stringify(join(root, 'out/module.mjs'))}, { ...${options}, version: 2 })`,
      `console.log(JSON.stringify([first.name, second.name]))`,
    ].join('\n')
    const { stdout } = await exec('node', ['--input-type=module', '-e', script])
    expect(JSON.parse(stdout)).toEqual(['one', 'two'])
    await rm(root, { recursive: true, force: true })
  })

  it('should leave TypeScript to Node\'s type stripping', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-strip-'))
    const line = `export const location: string = ((): string => new Error('here').stack!.split('\\n')[1]!)()`
    await writeFile(join(dir, 'entry.ts'), `${line}\nexport { kind } from './kind.ts'\n`)
    await writeFile(join(dir, 'kind.ts'), `const Kind = { Stub: 'stub' } as const\nexport const kind: string = Kind.Stub\n`)
    await writeFile(join(dir, 'enum.ts'), `export enum Mode { Build }\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const script = `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)}); const m = await importModule(${JSON.stringify(join(dir, 'entry.ts'))}, { cwd: ${JSON.stringify(dir)} }); const rejected = await importModule(${JSON.stringify(join(dir, 'enum.ts'))}, { cwd: ${JSON.stringify(dir)} }).then(() => undefined, error => error.code); console.log(JSON.stringify([m.location, m.kind, rejected]))`
    const { stdout } = await exec('node', ['--input-type=module', '-e', script], { nodeOptions: { env: { ...process.env, CI: '1' } } })
    const [location, kind, rejected] = JSON.parse(stdout) as [string, string, string]
    expect(location).toContain(`entry.ts:1:${line.indexOf('new Error') + 1}`)
    expect(kind).toBe('stub')
    expect(rejected).toBe('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('declarationPaths', () => {
  it('should leave generated aliases to ambient declarations and drop installed packages mapped into `node_modules`', () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    const { paths, ambient } = declarationPaths({
      '#build': ['/app/.nuxt'],
      '#build/*': ['/app/.nuxt/*'],
      '#internal/nuxt/paths': ['/app/node_modules/nuxt/dist/core/runtime/nitro/utils/paths'],
      '#components': ['/app/.nuxt/components'],
      '#imports': ['/app/.nuxt/imports'],
      '#app': ['/app/node_modules/.pnpm/nuxt@4.0.0/node_modules/nuxt/dist/app'],
      'pathe': ['/app/node_modules/.pnpm/pathe@2.0.0/node_modules/pathe'],
      'not-installed-package': ['/app/node_modules/.pnpm/not-installed-package@1.0.0/node_modules/not-installed-package'],
      '~/*': ['/app/*'],
    }, cwd)
    expect(ambient).toEqual(['#build', '#build/*', '#internal/nuxt/paths', '#components'])
    expect(Object.keys(paths)).toEqual(['#build/server-routes', '#imports', '#app', 'not-installed-package', '~/*'])
    expect(paths['#build/server-routes']![0]).toMatch(/[\\/]node_modules[\\/]\.cache[\\/]transpile-dir[\\/][0-9a-f]{12}\.d\.ts$/)
  })

  it('should write the server routes stub once and leave no temporary file behind', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-stub-'))
    const file = await writeServerRoutesStub(cwd)
    const written = await stat(file)
    expect(await writeServerRoutesStub(cwd)).toBe(file)
    expect((await stat(file)).mtimeMs).toBe(written.mtimeMs)
    expect(await readdir(dirname(file))).toEqual([basename(file)])
    expect(await readFile(file, 'utf-8')).toBe(SERVER_ROUTES_STUB)
    await rm(cwd, { recursive: true, force: true })
  })

  it('should export from the server routes stub every name Nuxt\'s fetch types import from `#build/server-routes`', async () => {
    const require = createRequire(import.meta.url)
    const fetchTypes = await readFile(join(dirname(require.resolve('nuxt/package.json')), 'dist/app/types/fetch.d.ts'), 'utf-8')
    const imported = [...fetchTypes.matchAll(/import (?:type )?\{([^}]+)\} from ["']#build\/server-routes["']/g)]
      .flatMap(match => match[1]!.split(',').map(name => name.trim().replace(/^type /, '')))
    const exported = [...SERVER_ROUTES_STUB.matchAll(/^export (?:type|interface) (\w+)/gm)].map(match => match[1])
    expect(imported.length > 0).toBe(satisfies(nuxtVersion, '>=4.6.0'))
    expect(imported.filter(name => !exported.includes(name))).toEqual([])
  })
})

describe('builder options', () => {
  const cwd = fileURLToPath(new URL('../example', import.meta.url))
  const outDir = join(cwd, 'dist')

  it('should translate entries, externals and both shapes of replacements', () => {
    const config = resolveModuleOptions(cwd, { name: 'my-module' }, outDir, {
      entries: ['src/utils', { input: 'src/shared/', outDir: 'dist/shared', ext: 'js' }],
      externals: ['fake-pkg'],
      replace: { __A__: '"a"' },
    })
    expect(config.entries).toEqual({ utils: './src/utils.ts' })
    expect(config.directories).toEqual([{ srcDir: join(cwd, 'src/shared'), outDir: join(outDir, 'shared'), ext: 'js' }])
    expect(config.neverBundle.map(String)).toEqual(['/^fake-pkg(?:\\/|$)/', '/^my-module(?:$|\\/(?!runtime\\/))/'])
    expect(config.replace).toEqual({ values: { __A__: '"a"' }, preventAssignment: true })
    expect(resolveModuleOptions(cwd, {}, outDir, { replace: { delimiters: ['', ''], values: { __B__: '"b"' } } }).replace).toEqual({ values: { __B__: '"b"' }, delimiters: ['', ''], preventAssignment: true })
  })

  it('should refuse options it does not accept', () => {
    expect(() => resolveModuleOptions(cwd, {}, outDir, { outDir: 'lib', entries: [{ input: 'src/x/', ext: 'cjs' }] } as never)).toThrow(diagnostic('NUXT_MB_C0009', '`builder()` does not support these options:\n  - outDir\n  - entries[0].ext'))
  })

  it('should refuse a bundled entry named `types`', () => {
    for (const entries of [[{ input: './src/utils', name: 'types' }], [{ input: './src/utils', name: 'Types' }], ['./src/types']]) {
      expect(() => resolveModuleOptions(cwd, {}, outDir, { entries })).toThrow(diagnostic('NUXT_MB_C0010'))
    }
  })

  it('should refuse `hooks` and point at tsdown\'s own', () => {
    expect(() => resolveModuleOptions(cwd, {}, outDir, { hooks: { 'build:before': () => {} } } as never)).toThrow(diagnostic('NUXT_MB_C0008'))
  })

  it('should list every tsdown option it sets that the config sets too', async () => {
    const config: UserConfig = {
      entry: 'src/index.ts',
      format: ['esm', 'cjs'],
      dts: false,
      clean: true,
      unbundle: true,
      exports: true,
      fixedExtension: false,
      outExtensions: () => ({}),
      platform: 'browser',
      workspace: true,
      external: ['a'],
      noExternal: ['b'],
      deps: { neverBundle: true },
    }
    await expect(setupBuilder(config, {}, {}, { legacy: false })).rejects.toThrow(diagnostic('NUXT_MB_C0001', [
      '`builder()` sets these tsdown options itself, and the tsdown config sets them too:',
      '  - `entry`: list bundled entries besides `src/module` in `builder({ entries })`',
      '  - `format`: modules are built as ES modules only',
      '  - `dts`: declarations are generated with the module\'s own tsconfig',
      '  - `clean`: the output directory is emptied before a one-off build, and a watched build removes the files it no longer emits',
      '  - `unbundle`: the module entry is bundled, and runtime directories are transpiled file by file',
      '  - `exports`: the exports tsdown generates leave out `types.d.mts` and the runtime directories',
      '  - `fixedExtension`: the module entry is emitted as `module.mjs`',
      '  - `outExtensions`: the module entry is emitted as `module.mjs`',
      '  - `platform`: Nuxt modules run in Node',
      '  - `workspace`: give each module a tsdown config of its own',
      '  - `external`: use `builder({ externals })` or `deps.neverBundle`',
      '  - `noExternal`: use `deps.alwaysBundle`',
      '  - `deps.neverBundle`: list the imports that are never bundled',
    ].join('\n')))
  })

  it('should turn off rolldown\'s timings report unless the config sets it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-checks-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, '.nuxt'))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, '.nuxt/tsconfig.json'), '{}')
    await writeFile(join(root, 'src/module.ts'), 'export default {}\n')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'my-module' }))
    const checks = async (config: UserConfig) => {
      await setupBuilder(config, {}, {}, {})
      return config.checks
    }
    expect(await checks({ cwd: root })).toEqual({ bundlerTimings: false })
    expect(await checks({ cwd: root, checks: { legacyCjs: false } })).toEqual({ bundlerTimings: false, legacyCjs: false })
    expect(await checks({ cwd: root, checks: { bundlerTimings: true } })).toEqual({ bundlerTimings: true })
    expect(await checks({ cwd: root, checks: { pluginTimings: true } })).toEqual({ pluginTimings: true })
  })
})

describe('unchangedOutputs', () => {
  const asset = (fileName: string, source: string) => ({ type: 'asset', fileName, source, names: [], originalFileNames: [], name: undefined, originalFileName: null }) as unknown as Rolldown.OutputAsset
  const bundleOf = (files: Record<string, string>): Rolldown.OutputBundle => Object.fromEntries(Object.entries(files).map(([fileName, source]) => [fileName, asset(fileName, source)]))

  it('should prune the outputs that the last written build emitted with the same content and that still exist', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'module-builder-unchanged-'))
    await writeFile(join(outDir, 'a.js'), 'a')
    const unchanged = unchangedOutputs(outDir)
    const first = bundleOf({ 'a.js': 'a', 'b.js': 'b' })
    unchanged.prune(first)
    expect(Object.keys(first)).toEqual(['a.js', 'b.js'])
    unchanged.commit()

    const second = bundleOf({ 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' })
    unchanged.prune(second)
    expect(Object.keys(second)).toEqual(['b.js', 'c.js'])
    expect(Object.keys(unchanged.bundle)).toEqual(['a.js', 'b.js', 'c.js'])

    const third = bundleOf({ 'a.js': 'changed' })
    unchanged.prune(third)
    expect(Object.keys(third)).toEqual(['a.js'])
    await rm(outDir, { recursive: true, force: true })
  })

  it('should write every output after a build whose writes did not all complete', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'module-builder-unchanged-'))
    await writeFile(join(outDir, 'a.js'), 'a')
    const unchanged = unchangedOutputs(outDir)
    unchanged.prune(bundleOf({ 'a.js': 'a' }))
    unchanged.commit()
    unchanged.prune(bundleOf({ 'a.js': 'changed' }))
    const next = bundleOf({ 'a.js': 'a' })
    unchanged.prune(next)
    expect(Object.keys(next)).toEqual(['a.js'])
    await rm(outDir, { recursive: true, force: true })
  })

  it('should write a declaration again when the files its specifiers resolve to change', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'module-builder-unchanged-'))
    await writeFile(join(outDir, 'a.d.ts'), `export * from './b/index.js'\n`)
    const unchanged = unchangedOutputs(outDir)
    unchanged.prune(bundleOf({ 'a.d.ts': `export * from './b'\n`, 'b/index.d.ts': '' }))
    unchanged.commit()
    const same = bundleOf({ 'a.d.ts': `export * from './b'\n`, 'b/index.d.ts': '' })
    unchanged.prune(same)
    expect(Object.keys(same)).toEqual(['b/index.d.ts'])
    unchanged.commit()
    const moved = bundleOf({ 'a.d.ts': `export * from './b'\n`, 'b.d.ts': '' })
    unchanged.prune(moved)
    expect(Object.keys(moved)).toEqual(['a.d.ts', 'b.d.ts'])
    await rm(outDir, { recursive: true, force: true })
  })

  it('should find the directory index a specifier with a trailing slash resolves to', () => {
    expect(declarationTargets('runtime/a.d.ts', `export * from './b/'\n`)).toContain('runtime/b/index.d.ts')
  })
})

describe('size report', () => {
  it('should default to a summary when the build has runtime directories, and leave a configured `report` alone', () => {
    expect(defaultReport(undefined, true)).toEqual({ summary: true })
    expect(defaultReport(undefined, false)).toBe(true)
    for (const report of [false, true, { gzip: false }, { summary: false }]) {
      expect(defaultReport(report, true)).toBe(report)
    }
  })

  it('should only add the breakdown to a summary', () => {
    expect([{ summary: true }, {}, false, undefined].map(reportsSummary)).toEqual([true, false, false, false])
  })

  it('should break the output down by bundled entry and runtime directory, leaving out source maps', () => {
    const chunk = (fileName: string, code: string) => [fileName, { type: 'chunk', fileName, code }]
    const asset = (fileName: string, source: string) => [fileName, { type: 'asset', fileName, source }]
    const bundle = Object.fromEntries([
      chunk('module.mjs', 'x'.repeat(436)),
      asset('module.d.mts', 'x'.repeat(1160)),
      chunk('utils.mjs', 'x'.repeat(10)),
      asset('runtime/plugin.js', 'x'.repeat(1000)),
      asset('runtime/plugin.d.ts', 'x'.repeat(2000)),
      asset('runtime/plugin.js.map', 'x'.repeat(5000)),
      asset('runtime/Card.vue', 'x'.repeat(260)),
      asset('runtime/Card.d.vue.ts', 'x'.repeat(810)),
    ]) as unknown as Rolldown.OutputBundle
    const lines = sizeBreakdown(bundle, {
      cwd: '/mod',
      outDir: '/mod/dist',
      entries: { utils: './src/utils.ts', module: './src/module.ts' },
      directories: [{ srcDir: '/mod/src/runtime', outDir: '/mod/dist/runtime', ext: 'js' }, { srcDir: '/mod/src/empty', outDir: '/mod/dist/empty', ext: 'mjs' }],
    })
    expect(lines.map(line => line.replace(/\s+/g, ' '))).toEqual([
      'dist/utils.mjs 10 B',
      'dist/module.mjs 436 B · types 1.16 kB',
      'dist/runtime/ 1.26 kB · types 2.81 kB · 4 files',
    ])

    const rootLevel = sizeBreakdown(Object.fromEntries([
      ...Object.entries(bundle),
      asset('shared.js', 'x'.repeat(30)),
      asset('shared.d.ts', 'x'.repeat(40)),
    ]) as unknown as Rolldown.OutputBundle, {
      cwd: '/mod',
      outDir: '/mod/dist',
      entries: { utils: './src/utils.ts', module: './src/module.ts' },
      directories: [{ srcDir: '/mod/src/runtime', outDir: '/mod/dist/runtime', ext: 'js' }, { srcDir: '/mod/src/shared', outDir: '/mod/dist', ext: 'js' }],
    })
    expect(rootLevel.map(line => line.replace(/\s+/g, ' ')).slice(2)).toEqual([
      'dist/runtime/ 1.26 kB · types 2.81 kB · 4 files',
      'dist/ 30 B · types 40 B · 2 files',
    ])
  })
})

describe('resolveOutDir', () => {
  it('should resolve an output directory inside the module and refuse one containing it', () => {
    expect(resolveOutDir('/repo/mod', 'dist')).toBe('/repo/mod/dist')
    expect(resolveOutDir('/repo/mod', '/repo/mod/.stub')).toBe('/repo/mod/.stub')
    expect(resolveOutDir('/repo/mod', '..dist')).toBe('/repo/mod/..dist')
    for (const outDir of ['.', '..', '/repo', '/repo/mod', '../mod', '../sibling', '/elsewhere/dist']) {
      expect(() => resolveOutDir('/repo/mod', outDir)).toThrow(diagnostic('NUXT_MB_C0012', 'is not inside the module root'))
    }
  })

  it('should refuse an output directory that a symlink inside the module points outside it', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'module-builder-outdir-')))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'mod'))
    await mkdir(join(root, 'other'))
    await symlink(join(root, 'other'), join(root, 'mod/linked'))
    await symlink(join(root, 'mod'), join(root, 'mod/self'))
    await mkdir(join(root, 'mod/output'))
    await symlink(join(root, 'mod/output'), join(root, 'mod/dist'))
    expect(() => resolveOutDir(join(root, 'mod'), 'linked/dist')).toThrow(`resolves to \`${join(root, 'other/dist')}\`, which is not inside the module root`)
    expect(() => resolveOutDir(join(root, 'mod'), 'self')).toThrow(`resolves to \`${join(root, 'mod')}\`, which is not inside the module root`)
    expect(resolveOutDir(join(root, 'mod'), 'dist')).toBe(join(root, 'mod/dist'))
  })
})

describe('createTsconfigResolver', () => {
  it('should fail with a diagnostic naming the module\'s tsconfig, or a project it references, that cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-unreadable-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const cwd = join(root, 'mod')
    await mkdir(join(root, 'shared'), { recursive: true })
    await mkdir(cwd)
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ extends: './missing.json' }))
    await expect(moduleTsconfigs(cwd)).rejects.toEqual(diagnostic('NUXT_MB_C0302', 'Cannot read `tsconfig.json`, the module\'s tsconfig: '))
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.module.json' }] }))
    await writeFile(join(cwd, 'tsconfig.module.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json' }))
    await expect(moduleTsconfigs(cwd)).rejects.toEqual(diagnostic('NUXT_MB_C0302', 'Cannot read `tsconfig.module.json`, a project that the tsconfig of the module references: '))
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: '../shared' }] }))
    await writeFile(join(root, 'shared/tsconfig.json'), JSON.stringify({ extends: './missing.json' }))
    await expect(moduleTsconfigs(cwd)).rejects.toEqual(diagnostic('NUXT_MB_C0302', 'Cannot read `../shared/tsconfig.json`, a project that the tsconfig of the module references: '))
  })

  it('should rebuild a tsconfig that takes its types from a playground on the module\'s own `.nuxt`, keeping its other options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-foreign-'))
    await mkdir(join(cwd, '.nuxt'))
    await mkdir(join(cwd, 'playground/.nuxt'), { recursive: true })
    await writeFile(join(cwd, '.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], paths: { '#build/*': ['./*'], '#shared': ['../shared'] } }, include: ['./nuxt.d.ts', '../src/**/*'] }))
    await writeFile(join(cwd, 'playground/.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { types: ['playground-types'], paths: { '#build/*': ['./*'], '#playground': ['../app'] } }, include: ['../**/*'] }))
    await mkdir(join(cwd, 'config'))
    await writeFile(join(cwd, 'config/base.json'), JSON.stringify({ compilerOptions: { types: ['global-types'], noUncheckedIndexedAccess: true, rootDir: '${configDir}', paths: { '#shared': ['${configDir}/other'], '#mine/*': ['${configDir}/mine/*'] } } }))
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ extends: ['./config/base.json', './playground/.nuxt/tsconfig.json'], compilerOptions: { exactOptionalPropertyTypes: true }, references: [{ path: './playground/.nuxt/tsconfig.app.json' }, { path: './tsconfig.node.json' }] }))
    await writeFile(join(cwd, 'tsconfig.node.json'), JSON.stringify({ compilerOptions: {}, include: ['nuxt.config.ts'] }))
    await writeFile(join(cwd, 'playground/.nuxt/tsconfig.app.json'), JSON.stringify({ compilerOptions: { types: ['playground-types'] }, include: ['../**/*'] }))
    const { root, replaced } = await createTsconfigResolver(cwd)
    expect(replaced).toBe(join(cwd, 'tsconfig.json'))
    expect(root!.path).not.toBe(join(cwd, 'tsconfig.json'))
    const options = root!.config.compilerOptions!
    expect(options.strict).toBe(true)
    expect(options.noUncheckedIndexedAccess).toBe(true)
    expect(options.exactOptionalPropertyTypes).toBe(true)
    expect(options.types).toEqual(['global-types'])
    expect(resolve(dirname(root!.path), options.rootDir!)).toBe(cwd)
    expect(tsconfigPaths(root)).toEqual({ '#build/*': [join(cwd, '.nuxt/*')], '#shared': [join(cwd, 'shared')], '#mine/*': [join(cwd, 'mine/*')] })
    expect(root!.config.references).toEqual([{ path: join(cwd, 'tsconfig.node.json') }])
    expect(root!.config.include).toEqual(['../../../.nuxt/nuxt.d.ts', '../../../.nuxt/../src/**/*'])
    await rm(cwd, { recursive: true, force: true })
  })

  it('should resolve each file to the referenced project that includes it, preferring the module\'s own tsconfigs and leaving the app\'s last', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-references-'))
    await mkdir(join(cwd, '.nuxt'))
    const write = (file: string, config: object) => writeFile(join(cwd, file), JSON.stringify(config))
    await write('.nuxt/tsconfig.app.json', { include: ['../src/runtime'] })
    await write('.nuxt/tsconfig.server.json', { include: ['../src/runtime/server'] })
    await write('.nuxt/tsconfig.node.json', { include: ['../src/*.ts'] })
    await write('tsconfig.module.json', { extends: './.nuxt/tsconfig.node.json', references: [{ path: './tsconfig.extra.json' }] })
    await write('tsconfig.extra.json', { include: ['extra'] })
    await write('tsconfig.json', { files: [], references: [{ path: './.nuxt/tsconfig.app.json' }, { path: './.nuxt/tsconfig.server.json' }, { path: './tsconfig.module.json' }] })
    const { resolve: projectOf } = await createTsconfigResolver(cwd)
    expect(projectOf(join(cwd, 'src/module.ts'))?.path).toBe(join(cwd, 'tsconfig.module.json'))
    expect(projectOf(join(cwd, 'extra/helper.ts'))?.path).toBe(join(cwd, 'tsconfig.extra.json'))
    expect(projectOf(join(cwd, 'src/runtime/server/api.ts'))?.path).toBe(join(cwd, '.nuxt/tsconfig.server.json'))
    expect(projectOf(join(cwd, 'src/runtime/plugin.ts'))?.path).toBe(join(cwd, '.nuxt/tsconfig.app.json'))

    await write('tsconfig.runtime.json', { extends: './.nuxt/tsconfig.app.json' })
    await write('tsconfig.json', { files: [], references: [{ path: './.nuxt/tsconfig.app.json' }, { path: './.nuxt/tsconfig.server.json' }, { path: './tsconfig.runtime.json' }] })
    expect((await createTsconfigResolver(cwd)).resolve(join(cwd, 'src/runtime/plugin.ts'))?.path).toBe(join(cwd, 'tsconfig.runtime.json'))
    await rm(cwd, { recursive: true, force: true })
  })

  it('should give each component a `tsconfig.json` with the options of its project, in its directory or above one that a component of another project has or that held other options', async () => {
    const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'module-builder-sfc-types-')))
    await mkdir(join(cwd, '.nuxt'))
    await mkdir(join(cwd, 'src/runtime'), { recursive: true })
    const write = (file: string, config: object) => writeFile(join(cwd, file), JSON.stringify(config))
    await write('.nuxt/tsconfig.app.json', { compilerOptions: { paths: { '#app-types': ['../src/runtime/types'] } }, include: ['../src/runtime'] })
    await write('tsconfig.app.json', { extends: './.nuxt/tsconfig.app.json', compilerOptions: { strict: true } })
    await write('tsconfig.other.json', { compilerOptions: { paths: { '#other-types': ['./src/other'] } } })
    await write('src/runtime/tsconfig.json', { compilerOptions: { paths: { '#unused': ['./unused'] } } })
    const projects = Object.fromEntries(['tsconfig.app.json', 'tsconfig.other.json'].map(file => [file, { path: join(cwd, file), config: parseTsconfig(join(cwd, file)) }]))
    const files = ['A.vue', 'B.vue', 'C.vue'].map(name => join(cwd, 'src/runtime', name))
    const fs = await typeResolutionFs(files, file => projects[file.endsWith('B.vue') ? 'tsconfig.other.json' : 'tsconfig.app.json'])
    const options = (file: string) => {
      const host = fs.get(file)!
      const path = ts.findConfigFile(file, host.fileExists)!
      const { compilerOptions } = ts.readConfigFile(path, host.readFile).config
      return { path, compilerOptions }
    }
    const app = { path: join(cwd, 'src/runtime/tsconfig.json'), compilerOptions: { paths: { '#app-types': [join(cwd, 'src/runtime/types')] }, strict: true } }
    expect(options(files[0]!)).toEqual(app)
    expect(options(files[1]!)).toEqual({ path: join(cwd, 'src/tsconfig.json'), compilerOptions: { paths: { '#other-types': [join(cwd, 'src/other')] } } })
    expect(options(files[2]!)).toEqual(app)

    await write('tsconfig.other.json', { compilerOptions: { paths: { '#other-types': ['./src/changed'] } } })
    projects['tsconfig.other.json']!.config = parseTsconfig(join(cwd, 'tsconfig.other.json'))
    const rebuilt = await typeResolutionFs([files[1]!], () => projects['tsconfig.other.json'])
    const host = rebuilt.get(files[1]!)!
    const path = ts.findConfigFile(files[1]!, host.fileExists)!
    expect(path).toBe(join(cwd, 'tsconfig.json'))
    expect(ts.readConfigFile(path, host.readFile).config).toEqual({ compilerOptions: { paths: { '#other-types': [join(cwd, 'src/changed')] } } })
    await rm(cwd, { recursive: true, force: true })
  })

  it('should read the root `compilerOptions` and `exclude` through `extends`, apart from tsconfigs in `.nuxt`, with `paths` resolved against the merged `baseUrl`', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-root-'))
    await mkdir(join(cwd, '.nuxt'))
    await mkdir(join(cwd, 'config'))
    const write = (file: string, config: object) => writeFile(join(cwd, file), JSON.stringify(config))
    await write('.nuxt/tsconfig.node.json', { compilerOptions: { types: ['generated'] }, exclude: ['../generated'] })
    await write('config/base.json', { compilerOptions: { types: ['vitest/config', './types/globals.d.ts'], strict: true }, exclude: ['../test'] })
    await write('tsconfig.json', { extends: ['./config/base', './.nuxt/tsconfig.node.json'], files: [], compilerOptions: { strict: false } })
    expect(await rootTsconfig(cwd)).toEqual({ compilerOptions: { types: ['vitest/config', join(cwd, 'types/globals.d.ts')], strict: false }, exclude: [join(cwd, 'test')] })
    await write('tsconfig.json', { extends: './config/base.json', exclude: ['dist'] })
    expect((await rootTsconfig(cwd)).exclude).toEqual([join(cwd, 'dist')])
    await mkdir(join(cwd, 'node_modules/shared-config'), { recursive: true })
    await write('node_modules/shared-config/package.json', { name: 'shared-config', tsconfig: 'base.json' })
    await write('node_modules/shared-config/base.json', { compilerOptions: { types: ['youtube'] } })
    await write('tsconfig.json', { extends: 'shared-config', files: [] })
    expect((await rootTsconfig(cwd)).compilerOptions).toEqual({ types: ['youtube'] })
    const tsPaths = () => {
      const { options } = ts.getParsedCommandLineOfConfigFile(join(cwd, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!
      return Object.fromEntries(Object.entries(options.paths!).map(([alias, targets]) => [alias, targets.map(target => resolve(options.baseUrl ?? options.pathsBasePath as string, target))]))
    }
    await write('config/base.json', { compilerOptions: { baseUrl: '../src' } })
    await write('tsconfig.json', { extends: './config/base.json', files: [], compilerOptions: { paths: { '#types': ['types'] } } })
    expect((await rootTsconfig(cwd)).compilerOptions.paths).toEqual({ '#types': [join(cwd, 'src/types')] })
    expect((await rootTsconfig(cwd)).compilerOptions.paths).toEqual(tsPaths())
    await write('config/base.json', { compilerOptions: { paths: { '#types': ['./types'] } } })
    await write('tsconfig.json', { extends: './config/base.json', files: [], compilerOptions: { baseUrl: './src' } })
    expect((await rootTsconfig(cwd)).compilerOptions.paths).toEqual({ '#types': [join(cwd, 'src/types')] })
    expect((await rootTsconfig(cwd)).compilerOptions.paths).toEqual(tsPaths())
    await rm(cwd, { recursive: true, force: true })
  })

  it('should keep a tsconfig that takes its types from the module\'s own `.nuxt`', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-own-'))
    await mkdir(join(cwd, '.nuxt'))
    await writeFile(join(cwd, '.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '#build/*': ['./*'] } } }))
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ extends: './.nuxt/tsconfig.json' }))
    const { root, replaced } = await createTsconfigResolver(cwd)
    expect(replaced).toBeUndefined()
    expect(root!.path).toBe(join(cwd, 'tsconfig.json'))
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('writeDerivedTsconfig', () => {
  it('should type imports of generated aliases as `any` under `strict`, in referenced projects too', async () => {
    const { default: ts } = await import('typescript')
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-untyped-'))
    const source = join(cwd, 'src/use.ts')
    await mkdir(join(cwd, 'src'))
    await writeFile(source, [
      `import theme, { variants } from '#build/ui/button'`,
      `import * as config from '#build/app.config'`,
      `export const useButton = () => ({ theme: theme.slots, variants: variants.size, config: config.default.ui })`,
      ``,
    ].join('\n'))
    const compilerOptions = { strict: true, noEmit: true, module: 'ESNext', moduleResolution: 'Bundler', esModuleInterop: true, paths: { '#build': ['./.nuxt'], '#build/*': ['./.nuxt/*'] } }
    await writeFile(join(cwd, 'tsconfig.app.json'), JSON.stringify({ compilerOptions, include: ['src/**/*'] }))
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }))
    const parse = (tsconfig: string) => ts.getParsedCommandLineOfConfigFile(tsconfig, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!
    const diagnostics = (parsed: import('typescript').ParsedCommandLine) => ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options))
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))

    const derived = parse(await writeDerivedTsconfig(cwd, (await createTsconfigResolver(cwd)).root!, {}))
    expect(derived.fileNames).toEqual([])
    const project = parse(ts.resolveProjectReferencePath(derived.projectReferences![0]!))
    expect(project.fileNames).toEqual([source])
    expect(Object.keys(project.options.paths!)).toEqual(['#build/server-routes'])
    expect(diagnostics(project)).toEqual([])
    expect(diagnostics(parse(join(cwd, 'tsconfig.app.json')))).not.toEqual([])
    await rm(cwd, { recursive: true, force: true })
  })

  it('should list the files of the module, leaving out its playground, docs and tests, for a tsconfig without `include` or `files`', async () => {
    const { default: ts } = await import('typescript')
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-implicit-'))
    await mkdir(join(cwd, 'src'))
    await mkdir(join(cwd, 'playground/.nuxt'), { recursive: true })
    await mkdir(join(cwd, 'node_modules/dep'), { recursive: true })
    await writeFile(join(cwd, 'global.d.ts'), `declare const __FIXTURE__: string\n`)
    await writeFile(join(cwd, 'src/use.ts'), `export const use = () => __FIXTURE__\n`)
    await writeFile(join(cwd, 'playground/app.ts'), `export const app = 1\n`)
    await writeFile(join(cwd, 'playground/.nuxt/nuxt.d.ts'), `declare const __APP__: string\n`)
    await mkdir(join(cwd, 'docs'))
    await mkdir(join(cwd, 'test'))
    await writeFile(join(cwd, 'docs/env.d.ts'), `declare const __DOCS__: string\n`)
    await writeFile(join(cwd, 'test/setup.ts'), `export const setup = 1\n`)
    await writeFile(join(cwd, 'node_modules/dep/index.ts'), `export const dep = 1\n`)
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'ESNext', moduleResolution: 'Bundler' } }))
    const derived = await writeDerivedTsconfig(cwd, (await createTsconfigResolver(cwd)).root!, {})
    const names = (files: string[]) => files.map(file => file.slice(cwd.length + 1)).sort()
    expect(names(ts.getParsedCommandLineOfConfigFile(derived, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!.fileNames)).toEqual(['global.d.ts', 'src/use.ts'])
    expect(names(ts.parseJsonConfigFileContent(parseTsconfig(derived), ts.sys, dirname(derived)).fileNames)).toEqual(['global.d.ts', 'src/use.ts'])
    await rm(cwd, { recursive: true, force: true })
  })
})

describe('transformCss', () => {
  it('should pass unknown at-rules through without warning and warn about other problems', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-css-'))
    const file = join(dir, 'theme.css')
    await writeFile(file, `@source "../app";\n@custom-variant dark (&:where(.dark, .dark *));\n@theme { --color-brand: red; }\n.a { @apply flex; }\na:hover:typo { color: red }\n`)
    const warn = vi.fn()
    const code = (await transformCss(file, dir, warn)).toString()
    expect(code).toContain('@source "../app"')
    expect(code).toContain('@theme{--color-brand: red;}')
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`'typo' is not recognized`))
    await rm(dir, { recursive: true, force: true })
  })
})

describe('rewriteRuntimeDeclarations', () => {
  it('should point relative specifiers in runtime declarations at the emitted files', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'module-builder-declarations-'))
    const files = {
      'module.d.ts': '',
      'runtime/utils/props.d.ts': '',
      'runtime/utils/index.d.ts': '',
      'runtime/components/Image.vue': '',
      'runtime/components/Image.vue.d.ts': [
        `import type { BaseProps } from '../utils/props'`,
        `import type { Utils } from '../utils'`,
        `import type { ModuleOptions } from '../../module.mjs'`,
        `import type Other from './Other.vue'`,
        `import type { Self } from './Image'`,
        `import type { NuxtApp } from '#app'`,
        `export type Kept = import('./missing')`,
      ].join('\n'),
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(join(dist, file, '..'), { recursive: true })
      await writeFile(join(dist, file), contents)
    }
    await rewriteRuntimeDeclarations(dist, ['runtime/components/Image.vue'])
    expect(await readFile(join(dist, 'runtime/components/Image.vue.d.ts'), 'utf-8')).toMatchInlineSnapshot(`
      "import type { BaseProps } from '../utils/props.js'
      import type { Utils } from '../utils/index.js'
      import type { ModuleOptions } from '../../module.js'
      import type Other from './Other.vue'
      import type { Self } from './Image.vue'
      import type { NuxtApp } from 'nuxt/app'
      export type Kept = import('./missing')"
    `)
    await rm(dist, { recursive: true, force: true })
  })
})

describe('build plan', () => {
  const tempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-plan-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  it('should resolve a module root reached through a symlink to its real path', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'real'))
    await symlink(join(dir, 'real'), join(dir, 'link'))
    expect(resolveCwdArg({ rootDir: join(dir, 'link') })).toBe(resolveCwdArg({ rootDir: join(dir, 'real') }))
    expect(resolveCwdArg({ cwd: join(dir, 'missing') })).toBe(join(realpathSync(dir), 'missing'))
  })

  it('should name the type check of the tsconfig in the module root, also when it takes its types from a playground', async () => {
    const cwd = await tempDir()
    await mkdir(join(cwd, '.nuxt'))
    await mkdir(join(cwd, 'playground/.nuxt'), { recursive: true })
    await mkdir(join(cwd, 'src'))
    await writeFile(join(cwd, 'src/module.ts'), 'export default {}\n')
    await writeFile(join(cwd, '.nuxt/tsconfig.json'), '{}')
    await writeFile(join(cwd, 'playground/.nuxt/tsconfig.app.json'), '{}')
    const pkg = { name: 'my-module' }
    const plan = (tsconfig: object) => writeFile(join(cwd, 'tsconfig.json'), JSON.stringify(tsconfig))
      .then(() => resolveBuild({ cwd, pkg, outDir: join(cwd, 'dist'), sourcemap: false, config: resolveModuleOptions(cwd, pkg, join(cwd, 'dist'), {}) }))
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    onTestFinished(() => info.mockRestore())
    expect((await plan({ files: [], references: [{ path: './playground/.nuxt/tsconfig.app.json' }] })).typeCheck).toBe('vue-tsc -b --noEmit')
    expect((await plan({ extends: './playground/.nuxt/tsconfig.app.json' })).typeCheck).toBe('vue-tsc --noEmit')
    expect((await plan({ extends: './.nuxt/tsconfig.json' })).typeCheck).toBe('vue-tsc --noEmit')
  })

  it('should change the declaration cache key with the nearest lockfile', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'module/.nuxt'), { recursive: true })
    await writeFile(join(dir, 'module/.nuxt/tsconfig.json'), '{}')
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const before = await hashGeneratedTypes(join(dir, 'module'))
    expect(await hashGeneratedTypes(join(dir, 'module'))).toBe(before)
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n')
    expect(await hashGeneratedTypes(join(dir, 'module'))).not.toBe(before)
  })

  it('should refuse a directory entry that emits `types.mjs` or `types.d.mts` at the root of the output', async () => {
    const cwd = await tempDir()
    const plan = { cwd, outDir: join(cwd, 'dist') } as BuildPlan
    for (const types of ['types.mjs', 'types.d.mts']) {
      await expect(finishBuild(plan, { outputs: ['runtime/a.js', types], builder: {}, keepOutput: true })).rejects.toThrow(`emits \`${types}\` at the root of \`dist\`, which would replace the generated \`types.d.mts\``)
    }
  })

  it('should keep the output when a step after the bundle fails in watch mode', async () => {
    const cwd = await tempDir()
    const outDir = join(cwd, 'dist')
    await mkdir(outDir)
    await writeFile(join(outDir, 'module.mjs'), `throw new Error('fails once built')\n`)
    const plan = { cwd, outDir, pkg: {} } as BuildPlan
    await expect(finishBuild(plan, { outputs: [], builder: {}, keepOutput: true })).rejects.toThrow('fails once built')
    expect(await readFile(join(outDir, 'module.mjs'), 'utf8')).toContain('fails once built')
    await expect(finishBuild(plan, { outputs: [], builder: {} })).rejects.toThrow('fails once built')
    expect(await readdir(cwd)).toEqual([])
  })

  it('should find literal dynamic imports with comments, template literals and options', () => {
    const code = [
      `import(/* @vite-ignore */ './a')`,
      'import(`./b`)',
      `import('./c', { with: { type: 'json' } })`,
      'import(`./${name}`)',
      `import(/* a */ /** b **/ './d')`,
      `import(/*${'*//*'.repeat(40)}x)`,
    ].join('\n')
    expect(moduleSpecifiers(code).map(({ specifier }) => specifier)).toEqual(['./a', './b', './c', './d'])
    expect([...valueSpecifiers(code)]).toEqual(['./a', './b', './c', './d'])
    expect(rewriteSpecifiers(`const load = () => import/* lazy */('./d')`, specifier => `${specifier}.js`)).toBe(`const load = () => import/* lazy */('./d.js')`)
  })

  it('should find imports with comments inside or before them, and imports of string names', () => {
    const code = [
      `import {\n  a, // the a's value\n} from './a'`,
      `/* b */import b from './b'`,
      `import { 'c-c' as c } from './c'`,
      `import type from './d'`,
    ].join('\n')
    expect(moduleSpecifiers(code).map(({ specifier }) => specifier)).toEqual(['./a', './b', './c', './d'])
    expect([...valueSpecifiers(code)]).toEqual(['./a', './b', './c', './d'])
  })

  it('should find `import = require()` declarations, the type-only ones as types', () => {
    const code = `import type Helper = require('./helper.cjs')\nimport fs = require('./fs.cjs')\nexport type { Helper, fs }\n`
    expect(moduleSpecifiers(code, 'module.d.ts').map(({ specifier }) => specifier)).toEqual(['./helper.cjs', './fs.cjs'])
    expect([...valueSpecifiers(code)]).toEqual(['./fs.cjs'])
    expect(rewriteSpecifiers(code, specifier => specifier.replace('.cjs', '.js'))).toBe(code.replaceAll('.cjs', '.js'))
  })

  it('should ignore import statements inside strings', () => {
    const template = 'const template = `\nimport x from \'./in-string\'\n`\n'
    expect(moduleSpecifiers(`@decorate\nclass A {}\n${template}`)).toEqual([])
    const sfc = `<template>\n  <p>Don't</p>\n</template>\n\n<script setup lang="ts">\nimport A from './a'\n${template}</script>\n`
    expect(moduleSpecifiers(sfc, 'Component.vue').map(({ specifier }) => specifier)).toEqual(['./a'])
    expect(rewriteSpecifiers(sfc, specifier => `${specifier}.js`, 'Component.vue')).toBe(sfc.replace(`'./a'`, `'./a.js'`))
  })

  it('should find the imports of a script block whose end tag has whitespace or attributes', () => {
    const sfc = `<script setup lang="ts">\nimport A from './a'\n</script\t\n bar>\n<template><A /></template>\n`
    expect(rewriteSpecifiers(sfc, specifier => `${specifier}.js`, 'Component.vue')).toBe(sfc.replace(`'./a'`, `'./a.js'`))
  })

  it('should escape a rewritten specifier for its quotes', () => {
    const code = `import './it\\'s'\nimport "./say \\"hi\\""\nconst lazy = import(\`./back\\\`tick\`)\n`
    expect(rewriteSpecifiers(code, specifier => `${specifier}.js`)).toBe(`import './it\\'s.js'\nimport "./say \\"hi\\".js"\nconst lazy = import(\`./back\\\`tick.js\`)\n`)
  })

  it('should find the imports of a script block with `>` in a quoted attribute', () => {
    const sfc = `<script setup lang="ts" generic="T extends Array<string>">import { x } from './x'\n</script>\n`
    expect(rewriteSpecifiers(sfc, specifier => `${specifier}.js`, 'Component.vue')).toBe(sfc.replace(`'./x'`, `'./x.js'`))
  })

  it('should treat a dot-prefixed name as a path inside the directory', () => {
    expect(relativeSpecifier('/mod/src/module.ts', '/mod/src/.generated/types.ts')).toBe('./.generated/types.ts')
    expect(relativeSpecifier('/mod/src/module.ts', '/mod/shared.ts')).toBe('../shared.ts')
  })

  it('should read a `package.json` that starts with a byte order mark', async () => {
    const cwd = await tempDir()
    await writeFile(join(cwd, 'package.json'), `\uFEFF${JSON.stringify({ name: 'bom' })}`)
    expect(await readPackageJson(cwd)).toEqual({ name: 'bom' })
  })

  it('should not follow declaration files when deciding which JSX to compile', async () => {
    const cwd = await tempDir()
    await mkdir(join(cwd, 'src/runtime/server'), { recursive: true })
    await writeFile(join(cwd, 'src/module.ts'), 'export default {}\n')
    await writeFile(join(cwd, 'src/runtime/server/types.d.ts'), `export { default } from '../Button'\n`)
    await writeFile(join(cwd, 'src/runtime/server/handler.ts'), `export default 'handler'\n`)
    await writeFile(join(cwd, 'src/runtime/Button.tsx'), `export default () => <button />\n`)
    const plan = { cwd, entries: { module: './src/module.ts' }, directories: [{ srcDir: join(cwd, 'src/runtime'), outDir: join(cwd, 'dist/runtime'), ext: 'js' }] } as unknown as BuildPlan
    const { compiledJsx } = analyseSources(plan)
    expect([...compiledJsx].sort()).toEqual([join(cwd, 'src/module.ts'), join(cwd, 'src/runtime/server/handler.ts')])
  })
})
