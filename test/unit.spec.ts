import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { satisfies } from 'verkit'
import { version as nuxtVersion } from 'nuxt/package.json'
import { consola } from 'consola'
import { basename, dirname, join, resolve } from 'pathe'
import { parseTsconfig } from 'get-tsconfig'
import { assertNoLegacyBuildConfig, bundledEntries, entryName, formatUnsupportedOptions, loadBuildConfig, resolveModuleOptions, resolveOutDir, translateBuildConfig, warnDeprecatedBuildConfig } from '../src/build/build-config.ts'
import { setupBuilder } from '../src/tsdown/setup.ts'
import { defaultReport, reportsSummary, sizeBreakdown } from '../src/tsdown/report.ts'
import { unchangedOutputs } from '../src/tsdown/unchanged.ts'
import type { Rolldown, UserConfig } from 'tsdown'
import { exec } from 'tinyexec'
import { runtimeExternals } from '../src/tsdown/runtime-externals.ts'
import { selfReferencePaths } from '../src/build/tsconfig.ts'
import { SERVER_ROUTES_STUB, createTsconfigResolver, declarationPaths, rootTsconfig, tsconfigPaths, writeDerivedTsconfig, writeServerRoutesStub } from '../src/rolldown/tsconfig.ts'
import { transformCss } from '../src/rolldown/stylesheets.ts'
import { declarationTargets, rewriteRuntimeDeclarations } from '../src/build/aliases.ts'
import { checkLegacyCJSPaths, checkLegacyDeclarationPaths, checkMissingPaths, checkNode10DeclarationPaths, checkStaleTypesField } from '../src/build/deprecations.ts'
import { importsKeyFor, publishedPackage, sourcePathsPackError, unpublishableImportsError, unpublishablePathsError } from '../src/build/package.ts'
import { writeSourceTypes } from '../src/build/types.ts'
import ts from 'typescript'
import { GUIDE_SECTIONS, guide } from '../src/build/guide.ts'
import { findModuleCodeIssues } from '../src/build/loader.ts'
import type { ModuleCodeIssue } from '../src/build/loader.ts'
import buildCommand, { MISSING_TSDOWN_HINT } from '../src/commands/build.ts'
import prepareCommand from '../src/commands/prepare.ts'

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
  it('should rewrite relative runtime imports to their built extension', async () => {
    await expect(createResolver()('./runtime/plugins/plugin')).resolves.toEqual({
      id: '/dist/runtime/plugins/plugin.js',
      external: true,
    })
  })

  it('should leave `.vue` specifiers untouched', async () => {
    await expect(createResolver()('./runtime/components/TestMe.vue')).resolves.toEqual({
      id: '/dist/runtime/components/TestMe.vue',
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

  it('should keep the name of non-code runtime files', async () => {
    await expect(createResolver()('./runtime/assets/config.json')).resolves.toEqual({
      id: '/dist/runtime/assets/config.json',
      external: true,
    })
  })

  it('should rewrite self-referencing runtime imports', async () => {
    await expect(createResolver('my-module')('my-module/runtime/plugins/plugin')).resolves.toEqual({
      id: '/dist/runtime/plugins/plugin.js',
      external: true,
    })
  })

  it('should treat a `.client` suffix in a self-referencing import as part of the name', async () => {
    await expect(createResolver('my-module')('my-module/runtime/plugins/plugin.client')).resolves.toEqual({
      id: '/dist/runtime/plugins/plugin.client.js',
      external: true,
    })
  })

  it('should ignore specifiers outside the runtime tree', async () => {
    await expect(createResolver('my-module')('@nuxt/kit')).resolves.toBeUndefined()
  })

  it('should ignore files that resolve outside the runtime tree', async () => {
    const resolveId = runtimeExternals(directories()).resolveId as (this: unknown, id: string, importer?: string) => Promise<unknown>
    const context = { resolve: async () => ({ id: join(runtimeSrcDir, '../utils.ts'), external: false }) }
    await expect(resolveId.call(context, './utils', importer)).resolves.toBeUndefined()
  })

  it('should point self-referencing directory imports at their index file', async () => {
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

  it('should import runtime files relative to the chunk that imports them', () => {
    const renderChunk = runtimeExternals(directories()).renderChunk as (code: string, chunk: { fileName: string, imports: string[], dynamicImports: string[] }, options: { dir?: string }) => { code: string } | undefined
    const code = 'import plugin from "/dist/runtime/plugins/plugin.js";\nconst lazy = () => import("/dist/runtime/lazy.js");\nconst path = "/dist/runtime/plugins/plugin.js/other";\n'
    const chunk = (fileName: string) => ({ fileName, imports: ['/dist/runtime/plugins/plugin.js'], dynamicImports: ['/dist/runtime/lazy.js'] })
    expect(renderChunk(code, chunk('module.mjs'), { dir: '/dist' })?.code).toContain('from "./runtime/plugins/plugin.js"')
    expect(renderChunk(code, chunk('nested/helper.mjs'), { dir: '/dist' })?.code).toBe(code
      .replace('"/dist/runtime/plugins/plugin.js"', '"../runtime/plugins/plugin.js"')
      .replace('"/dist/runtime/lazy.js"', '"../runtime/lazy.js"'))
  })
})

describe('translateBuildConfig', () => {
  const cwd = fileURLToPath(new URL('../example', import.meta.url))
  const outDir = join(cwd, 'dist')
  const translate = (...configs: unknown[]) => translateBuildConfig(configs.map((config, index) => ({ name: `config${index}`, config })), { cwd, outDir })

  it('should name entries the way unbuild did', () => {
    expect(entryName('src/vite', cwd)).toBe('vite')
    expect(entryName('./src/runtime/server/index.ts', cwd)).toBe('runtime/server/index')
    expect(entryName(join(cwd, 'src/cli.mts'), cwd)).toBe('cli')
    expect(entryName('lib/other', cwd)).toBe('lib/other')
  })

  it('should resolve entry inputs to their source file', () => {
    expect(translate({ entries: ['src/utils', { input: './src/utils.ts', name: 'helpers' }] }).entries).toEqual({
      utils: './src/utils.ts',
      helpers: './src/utils.ts',
    })
  })

  it('should skip a directory entry for `src/runtime` and keep others', () => {
    const { directories, unsupported } = translate({ entries: [{ input: 'src/runtime/', outDir: 'dist/runtime' }, { input: 'src/shared/', builder: 'mkdist', outDir: 'dist/shared' }, { input: 'src/features/', outDir: 'dist/features', ext: 'js' }, { input: 'src/other/', outDir: 'lib' }] })
    expect(directories).toEqual([
      { srcDir: join(cwd, 'src/shared'), outDir: join(outDir, 'shared'), ext: 'mjs' },
      { srcDir: join(cwd, 'src/features'), outDir: join(outDir, 'features'), ext: 'js' },
    ])
    expect(unsupported).toEqual(['config0: entries[3].outDir'])
  })

  it('should match string externals by package name', () => {
    const [pkg, alias] = translate({ externals: ['fake-pkg', '#alias'] }).neverBundle
    expect(['fake-pkg', 'fake-pkg/sub'].every(id => pkg!.test(id))).toBe(true)
    expect(pkg!.test('fake-pkg-other')).toBe(false)
    expect(alias!.test('#alias/config')).toBe(true)
  })

  it('should merge replacements with earlier configs taking precedence', () => {
    expect(translate(
      { replace: { __A__: '"a"' }, rollup: { replace: { delimiters: ['', ''], values: { __B__: '"b"' } } } },
      { replace: { __A__: '"overridden"', __C__: '"c"' } },
    ).replace).toEqual({ values: { __A__: '"a"', __B__: '"b"', __C__: '"c"' }, delimiters: ['', ''], preventAssignment: true })
    expect(translate({ replace: { __A__: '"a"' }, rollup: { replace: false } }).replace).toBeUndefined()
  })

  it('should accept options without an effect on the output', () => {
    expect(translate({
      declaration: 'node16',
      failOnWarn: false,
      name: 'my-module',
      rootDir: '.',
      outDir: 'dist',
      clean: true,
      entries: [{ input: 'src/features/', outDir: 'dist/features', ext: 'mjs', addRelativeDeclarationExtensions: true }],
      rollup: { emitCJS: false, cjsBridge: false, output: { exports: 'named' } },
    }).unsupported).toEqual([])
  })

  it('should keep supported hooks, ignore mkdist hooks and reject the rest', () => {
    const before = () => {}
    const done = () => {}
    const { hooks, ignoredHooks, unsupported } = translate({ hooks: { 'build:before': before, 'rollup:done': done, 'mkdist:entry:options': () => {}, 'rollup:options': () => {} } })
    expect(hooks).toEqual({ 'build:before': [before], 'rollup:done': [done], 'build:done': [] })
    expect(ignoredHooks).toEqual(['config0: hooks[\'mkdist:entry:options\']'])
    expect(unsupported).toEqual(['config0: hooks[\'rollup:options\']'])
  })

  it('should not duplicate the default module entry', () => {
    expect(bundledEntries(cwd, translate({ entries: ['src/module'] }))).toEqual({ module: './src/module.ts' })
  })

  it('should load a config file, then `package.json`', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-'))
    try {
      await writeFile(join(dir, 'build.config.mjs'), `export default [{ externals: ['a'] }, false]\n`)
      const config = await loadBuildConfig(dir, { build: { externals: ['b'] } }, join(dir, 'dist'))
      expect(config.file).toBe('build.config.mjs')
      expect(config.importsUnbuild).toBe(false)
      expect(config.field).toBe('build')
      expect(config.neverBundle.map(String)).toEqual(['/^a(?:\\/|$)/', '/^b(?:\\/|$)/'])
      expect(config.unsupported).toEqual([])

      await rm(join(dir, 'build.config.mjs'))
      await mkdir(join(dir, 'node_modules/unbuild'), { recursive: true })
      await writeFile(join(dir, 'node_modules/unbuild/package.json'), JSON.stringify({ name: 'unbuild', type: 'module', exports: './index.js' }))
      await writeFile(join(dir, 'node_modules/unbuild/index.js'), 'export const defineBuildConfig = config => config\n')
      await writeFile(join(dir, 'build.config.js'), `import { defineBuildConfig } from 'unbuild'\nexport default [defineBuildConfig({ externals: ['a'] }), { entries: ['src/utils'] }]\n`)
      expect(await loadBuildConfig(dir, {}, join(dir, 'dist'))).toMatchObject({ importsUnbuild: true, field: undefined, unsupported: ['build.config.js: an array of 2 configs'] })

      await rm(join(dir, 'build.config.js'))
      await writeFile(join(dir, 'build.config.mts'), 'export default () => ({})\n')
      await expect(loadBuildConfig(dir, {}, join(dir, 'dist'))).rejects.toThrow(`not a function. Replace the function with the object it returns. ${guide('other-options')}`)

      await rm(join(dir, 'build.config.mts'))
      await mkdir(join(dir, 'extensions/src/lib'), { recursive: true })
      await writeFile(join(dir, 'extensions/options.ts'), `export default { externals: ['o'] }\n`)
      await writeFile(join(dir, 'extensions/build.config.ts'), `import options from './options'\nexport default options\n`)
      await writeFile(join(dir, 'extensions/src/module.ts'), `import { helper } from './helper'\nexport { shared } from './lib'\nexport default helper\n`)
      await writeFile(join(dir, 'extensions/src/helper.ts'), `export const helper = 1\n`)
      await writeFile(join(dir, 'extensions/src/lib/index.ts'), `import { shared } from '../../options'\nexport { shared }\n`)
      await expect(loadBuildConfig(join(dir, 'extensions'), { build: { entries: ['src/lib/index'] } }, join(dir, 'dist'))).rejects.toThrow([
        'Module code has to load with Node, which strips types and resolves imports as written:',
        '  - build.config.ts:1:21: `./options` (use `./options.ts`)',
        '  - src/lib/index.ts:1:24: `../../options` (use `../../options.ts`)',
        '  - src/module.ts:1:24: `./helper` (use `./helper.ts`)',
        '  - src/module.ts:2:24: `./lib` (use `./lib/index.ts`)',
        `Change each one as suggested. ${guide('module-code-loads-with-node')}`,
      ].join('\n'))
      await writeFile(join(dir, 'extensions/build.config.ts'), `import options from './options.ts'\nexport default options\n`)
      expect((await loadBuildConfig(join(dir, 'extensions'), {}, join(dir, 'dist'))).neverBundle.map(String)).toEqual(['/^o(?:\\/|$)/'])

      expect(await loadBuildConfig(dir, {}, join(dir, 'dist'))).toMatchObject({ file: undefined, unsupported: [] })
      const fromPkg = await loadBuildConfig(dir, { unbuild: { externals: ['u'] }, build: { externals: ['b'] } }, join(dir, 'dist'))
      expect(fromPkg.neverBundle.map(String)).toEqual(['/^u(?:\\/|$)/'])

      const inferred = (await loadBuildConfig(dir, { name: '@nuxt/image', imports: { '#image/*': './src/*.ts' } }, join(dir, 'dist'))).neverBundle
      expect(inferred).toHaveLength(1)
      expect(['@nuxt/image', '@nuxt/image/utils'].every(id => inferred[0]!.test(id))).toBe(true)
      expect(inferred[0]!.test('@nuxt/image/runtime/providers/ipx')).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('should collect every option without an equivalent', () => {
    expect(translate(
      { hooks: { 'build:prepare': () => {} }, rollup: { emitCJS: true, output: { format: 'cjs' } }, stubOptions: {} },
      { externals: [42], replace: { __FN__: () => '' } },
    ).unsupported).toEqual([
      'config0: hooks[\'build:prepare\']',
      'config0: rollup.emitCJS: true',
      'config0: rollup.output',
      'config0: stubOptions',
      'config1: externals[0]',
      'config1: replace[\'__FN__\']',
    ])
  })

  it('should point each unsupported option at its section of the upgrade guide', () => {
    const message = formatUnsupportedOptions(['build.config.ts: hooks[\'rollup:options\']', 'build.config.ts: rollup.emitCJS: true', 'build.config.ts: rollup.alias', 'build.config.ts: entries[0].esbuild', 'build.config.ts: stubOptions'])
    expect(message.split('\n')).toEqual([
      'The build config uses options that `@nuxt/module-builder` v2 does not support:',
      `  - build.config.ts: hooks['rollup:options'] (${guide('hooks')})`,
      `  - build.config.ts: rollup.emitCJS: true (${guide('commonjs-output')})`,
      `  - build.config.ts: rollup.alias (${guide('rollup-options')})`,
      `  - build.config.ts: entries[0].esbuild (${guide('mkdist-options')})`,
      `  - build.config.ts: stubOptions (${guide('other-options')})`,
      `Remove each of them from the file named. ${guide('unsupported-build-options')}`,
    ])
  })

  it('should warn about a deprecated config file and ignored hooks in CI too', () => {
    vi.stubEnv('CI', 'true')
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    try {
      const config = { ...translate({}), file: 'build.config.ts', importsUnbuild: true, ignoredHooks: ['build.config.ts: hooks[\'mkdist:entry:options\']'] }
      warnDeprecatedBuildConfig(config)
      warnDeprecatedBuildConfig({ ...config, importsUnbuild: false, ignoredHooks: [], field: 'unbuild' })
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        expect.stringMatching(new RegExp(`^Ignoring build\\.config\\.ts: hooks\\['mkdist:entry:options'\\]: .*Remove the hook\\. ${guide('hooks')}$`)),
        expect.stringMatching(new RegExp(`^\`build\\.config\\.ts\` is deprecated\\. .*instead of \`unbuild\`\\. Move them into \`builder\\(\\)\` in \`tsdown\\.config\\.ts\`\\. ${guide('moving-from-buildconfigts')}$`)),
        `\`build.config.ts\` is deprecated. Its options are still applied. Move them into \`builder()\` in \`tsdown.config.ts\`. ${guide('moving-from-buildconfigts')}`,
        expect.stringMatching(new RegExp(`^The \`unbuild\` field of \`package\\.json\` is deprecated\\. .*Rename the field to \`build\`\\. ${guide('build-configuration')}$`)),
      ])
    }
    finally {
      warn.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

describe('upgrade guide', () => {
  it('should have a heading for every section that build messages link to', async () => {
    const markdown = await readFile(new URL('../docs/upgrade-v2.md', import.meta.url), 'utf8')
    const anchors = [...markdown.replace(/^```.*\n[\s\S]*?^```/gm, '').matchAll(/^#{2,6} (.+)$/gm)]
      .map(([, heading]) => heading!.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-'))
    expect(GUIDE_SECTIONS.filter(section => !anchors.includes(section))).toEqual([])
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
  it('should link the missing tsdown hint to the upgrade guide', () => {
    expect(MISSING_TSDOWN_HINT).toMatch(new RegExp(`pnpm add -D tsdown@"\\^[\\d.]+"\`\\. ${guide('install-tsdown')}$`))
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
      await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module', imports: { '#helper': { import: './src/esm.ts', require: './src/cjs.cjs' } } }))
      await writeFile(join(dir, 'src/module.ts'), `export { Mode } from '#helper'\n`)
      await writeFile(join(dir, 'src/esm.ts'), `export enum Mode { On }\n`)
      await writeFile(join(dir, 'src/cjs.cjs'), `exports.Mode = { On: 0 }\n`)
      expect(list(findModuleCodeIssues(dir, ['./src/module.ts'], []))).toEqual([
        'src/esm.ts:1:1: `enum` (use an `as const` object and a union type of its values)',
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
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    expect(checkLegacyDeclarationPaths(cwd, { exports: { '.': { types: './dist/module.d.ts' } } })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`Replace \`\\.d\\.ts\` with \`\\.d\\.mts\` in these \`package\\.json\` paths: \`\\./dist/module\\.d\\.ts\`\\. ${guide('declaration-paths')}$`)))
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
    expect(unpublishablePathsError(cwd, pkg)).toBe(`These published fields of \`package.json\` would not work once installed. Pointing at paths that the pack leaves out: \`types\` (\`./src/module.d.ts\`). Point them at the build output, in \`publishConfig\` when \`package.json\` points at the sources. To publish a file other than a TypeScript source as it is, add it to \`files\`. ${guide('publishing-source-exports')}`)
    expect(unpublishablePathsError(cwd, { ...pkg, publishConfig: { ...pkg.publishConfig, types: './dist/types.d.mts' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { ...pkg, publishConfig: undefined })).toContain('would not work once installed. Pointing at TypeScript sources, which Node does not load from `node_modules`: `exports` (`./src/module.ts`, `./src/utils.ts`). Pointing at paths that the pack leaves out: `exports`, `types` (`./.nuxt/module-builder/types.d.mts`, `./src/module.d.ts`). Point')
    expect(unpublishablePathsError(cwd, { files: ['dist', 'src/module.ts'], main: './src/module.ts' })).toContain('Pointing at TypeScript sources, which Node does not load from `node_modules`: `main` (`./src/module.ts`)')
  })

  it('should refuse published `imports` that point at TypeScript sources or that the pack leaves out only when the build output imports them', () => {
    const pkg = { files: ['dist', '.nuxt/ui.static.css'], imports: { '#internal/*': './src/internal/*.ts', '#shared': './shared/index.js', '#build/ui.css': './.nuxt/ui.static.css', '#dep': 'some-dependency' } }
    expect(unpublishablePathsError(cwd, pkg)).toBeUndefined()
    expect(unpublishableImportsError(cwd, pkg, () => false)).toBeUndefined()
    expect(unpublishableImportsError(cwd, pkg, () => true)).toBe(`The build output imports these \`imports\` of \`package.json\`, which would not work once installed. Pointing at TypeScript sources, which Node does not load from \`node_modules\`: \`#internal/*\` (\`./src/internal/*.ts\`). Pointing at paths that the pack leaves out: \`#shared\` (\`./shared/index.js\`). Point them at the build output, in \`publishConfig\` when \`package.json\` points at the sources. To publish a file other than a TypeScript source as it is, add it to \`files\`. ${guide('publishing-source-exports')}`)
    expect(unpublishableImportsError(cwd, pkg, key => key === '#shared')).not.toContain('#internal')
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
    expect(unpublishablePathsError(cwd, { files: ['dist', '!dist/private'], exports: { './private': './dist/private/a.mjs' } })).toContain('(`./dist/private/a.mjs`)')
    expect(unpublishablePathsError(cwd, { files: ['dist', '!dist/private'], exports: { './private/*': './dist/private/*' } })).toContain('(`./dist/private/*`)')
    expect(unpublishablePathsError(cwd, { files: ['dist/module.mjs', 'dist/runtime/*.d.ts'], exports: { './runtime/*': './dist/runtime/*.js' } })).toContain('(`./dist/runtime/*.js`)')
    expect(unpublishablePathsError(cwd, { files: ['dist/module.mjs', 'dist/runtime/**/*.js'], exports: { './runtime/*': './dist/runtime/*.js' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist/**/*.[cm]js', 'dist/**/*.d.mts'], exports: { './runtime': './dist/runtime/index.mjs' } })).toBeUndefined()
    expect(unpublishablePathsError(cwd, { files: ['dist/**/*.[!m]js'], exports: { './runtime': './dist/runtime/index.mjs' } })).toContain('(`./dist/runtime/index.mjs`)')
    expect(unpublishablePathsError(cwd, { files: ['{dist,lib}'], exports: { './a': './lib/a.js', './b': './other/b.js' } })).toContain('(`./other/b.js`)')
    expect(unpublishablePathsError(cwd, { exports: { '.': './.nuxt/module.mjs' } })).toContain('paths that the pack leaves out: `exports` (`./.nuxt/module.mjs`)')
  })

  it('should warn about referenced `module.cjs` output that is no longer generated', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    expect(checkLegacyCJSPaths(cwd, { main: './dist/module.cjs' })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`\`module\\.cjs\`.*Replace it with \`\\./dist/module\\.mjs\`.* ${guide('modulecjs')}$`)))
    warn.mockClear()
    expect(checkLegacyCJSPaths(cwd, { main: './dist/module.mjs' })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('should warn about other referenced paths the build did not produce', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-paths-'))
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist/module.mjs'), '')
    await writeFile(join(root, 'package.json'), '{}')
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
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
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`: \`\\./dist/utils\\.d\\.mts\`, \`\\./dist/utils\\.mjs\`\\. Add the entry that produces each one, or remove the path\\. ${guide('paths-the-build-does-not-produce')}$`)))
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
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    const pkg = {
      exports: { './util': './dist/util.mjs', './gone': './dist/gone.mjs' },
      typesVersions: { '*': { 'util': ['dist/util'], 'nested': ['./dist/nested'], 'legacy': ['dist/legacy'], 'gone': ['dist/gone'], 'runtime/*': ['dist/runtime/*'] } },
    }
    expect(checkNode10DeclarationPaths(root, pkg)).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`node10 module resolution.*: \`dist/util\` \\(use \`\\./dist/util\\.d\\.mts\`\\), \`\\./dist/nested\` \\(use \`\\./dist/nested/index\\.d\\.mts\`\\)\\. Write each path with its extension\\. ${guide('typesversions-paths')}$`)))
    warn.mockClear()
    expect(checkMissingPaths(root, pkg)).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(': `dist/gone`. Add the entry'))
    warn.mockClear()
    expect(checkNode10DeclarationPaths(root, { typesVersions: { '*': { util: ['dist/util.d.mts'], legacy: ['dist/legacy'] } } })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    await rm(root, { recursive: true, force: true })
  })

  it('should warn about a stale `types` field', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    expect(checkStaleTypesField(cwd, { types: './dist/nope.d.ts' })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(`\`types\` in \`package.json\` points at \`./dist/nope.d.ts\`, which the build does not produce. Set it to \`./dist/types.d.mts\`, which node10 module resolution reads, or remove it: bundler module resolution reads \`exports\` instead. ${guide('the-types-field')}`)
    warn.mockClear()
    expect(checkStaleTypesField(cwd, {})).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
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
    const fix = `Point them at \`dist\`, or pack and publish with pnpm or Yarn 4, which replace them with the \`dist\` paths in \`publishConfig\`. ${guide('publishing-source-exports')}`
    const paths = '`./.nuxt/module-builder/types.d.mts`, `./src/module.ts`, `./src/utils.ts`, `./src/runtime/shared/*.ts`'
    expect(sourcePathsPackError(cwd, pkg, npm)).toBe(`\`npm@11.19.0\` packs these fields of \`package.json\` as written, and they point at TypeScript sources or paths that \`files\` leaves out: \`exports\`, \`imports\`, \`main\`, \`types\` (${paths}). ${fix}`)
    expect(sourcePathsPackError(cwd, pkg, { ...npm, npm_lifecycle_event: 'prepublishOnly' })).toContain('`npm@11.19.0` packs')
    expect(sourcePathsPackError(cwd, pkg, yarnClassic)).toContain('`yarn@1.22.22` packs')
    expect(sourcePathsPackError(cwd, pkg, bun)).toContain('`bun@1.3.14` packs')
    expect(sourcePathsPackError(cwd, pkg, { npm_lifecycle_event: 'prepack' })).toContain('This package manager packs')
  })

  it('should name the package manager that packs when a script of another one runs it', () => {
    expect(sourcePathsPackError(cwd, pkg, { ...npm, npm_config_user_agent: pnpm.npm_config_user_agent })).toContain('`npm` packs')
    expect(sourcePathsPackError(cwd, pkg, { ...yarnClassic, npm_execpath: pnpm.npm_execpath })).toContain('`yarn@1.22.22` packs')
    expect(sourcePathsPackError(cwd, pkg, { ...yarnClassic, npm_execpath: npm.npm_execpath })).toContain('`yarn@1.22.22` packs')
    expect(sourcePathsPackError(cwd, pkg, { ...yarn, npm_execpath: npm.npm_execpath })).toContain('`npm` packs')
  })

  it('should refuse source paths that `publishConfig` does not replace', () => {
    const { types: _, ...publishConfig } = pkg.publishConfig
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig }, pnpm)).toBe(`These fields of \`package.json\` point at TypeScript sources or paths that \`files\` leaves out, and \`publishConfig\` does not replace them, so they would be published as written: \`types\` (\`./.nuxt/module-builder/types.d.mts\`). Set \`publishConfig.types\` to the \`dist\` paths. ${guide('publishing-source-exports')}`)
    expect(sourcePathsPackError(cwd, { exports: pkg.exports }, pnpm)).toContain('Set `publishConfig.exports` to the `dist` paths.')
  })

  it('should refuse `publishConfig` fields that point at sources', () => {
    const publishConfig = { ...pkg.publishConfig, main: './src/module.ts' }
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig }, pnpm)).toBe(`These fields of \`publishConfig\` point at TypeScript sources or paths that \`files\` leaves out, so they would be published that way: \`main\` (\`./src/module.ts\`). Point them at \`dist\`. ${guide('publishing-source-exports')}`)
    expect(sourcePathsPackError(cwd, { main: './dist/module.mjs', publishConfig: { main: './src/module.ts' } }, yarn)).toContain('These fields of `publishConfig` point at TypeScript sources')
    expect(sourcePathsPackError(cwd, { ...pkg, publishConfig: { ...pkg.publishConfig, typesVersions: { '*': { utils: ['./src/utils.ts'] } } } }, yarn)).toBeUndefined()
    expect(sourcePathsPackError(cwd, { files: ['dist/*.d.mts'], main: './dist/module.mjs', exports: './src/module.ts', publishConfig: { exports: './dist/module.mjs' } }, pnpm)).toBeUndefined()
  })

  it('should refuse `typesVersions` that point at sources when Yarn packs', () => {
    const typesVersions = { '*': { utils: ['./src/utils.ts'] } }
    const sourceTypesVersions = { ...pkg, typesVersions, publishConfig: { ...pkg.publishConfig, typesVersions: { '*': { utils: ['./dist/utils.d.mts'] } } } }
    expect(sourcePathsPackError(cwd, sourceTypesVersions, pnpm)).toBeUndefined()
    expect(sourcePathsPackError(cwd, sourceTypesVersions, yarn)).toBe(`\`yarn@4.18.1\` packs these fields of \`package.json\` as written, and they point at TypeScript sources or paths that \`files\` leaves out: \`typesVersions\` (\`./src/utils.ts\`). Point them at \`dist\`, or pack and publish with pnpm, which replace them with the \`dist\` paths in \`publishConfig\`. ${guide('publishing-source-exports')}`)
  })

  it('should refuse the fields that Yarn 2 and 3 pack as written', () => {
    const yarn2 = pack('yarn/2.4.2', '/tmp/xfs-b1b0ae8e/yarn')
    const yarn3 = pack('yarn/3.8.7', '/tmp/xfs-e94f6087/yarn')
    expect(sourcePathsPackError(cwd, pkg, yarn2)).toContain('`yarn@2.4.2` packs these fields of `package.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `exports`, `imports`, `types` (')
    expect(sourcePathsPackError(cwd, pkg, yarn3)).toContain('`yarn@3.8.7` packs these fields of `package.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `types` (`./.nuxt/module-builder/types.d.mts`)')
    expect(sourcePathsPackError(cwd, { main: pkg.main, publishConfig: { main: pkg.publishConfig.main } }, yarn2)).toBeUndefined()
    expect(sourcePathsPackError(cwd, pkg, pack('yarn/5.0.0', '/tmp/xfs-0/yarn'))).toContain('`yarn@5.0.0` packs')
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
})

describe('importModule', () => {
  it('should import files in an output directory outside the module afresh for each version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'module-builder-versions-'))
    await mkdir(join(root, 'module'))
    await mkdir(join(root, 'out/runtime'), { recursive: true })
    await writeFile(join(root, 'out/module.mjs'), `export { name } from './runtime/name.js'\n`)
    await writeFile(join(root, 'out/runtime/name.js'), `export const name = 'one'\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const options = JSON.stringify({ cwd: join(root, 'module'), outDir: join(root, 'out') })
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
    const script = `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)}); const m = await importModule(${JSON.stringify(join(dir, 'entry.ts'))}); const rejected = await importModule(${JSON.stringify(join(dir, 'enum.ts'))}).then(() => undefined, error => error.code); console.log(JSON.stringify([m.location, m.kind, rejected]))`
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
      'consola': ['/app/node_modules/.pnpm/consola@3.0.0/node_modules/consola'],
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
    expect(config.unsupported).toEqual([])
  })

  it('should collect options it does not accept', () => {
    expect(resolveModuleOptions(cwd, {}, outDir, { outDir: 'lib', entries: [{ input: 'src/x/', ext: 'cjs' }] } as never).unsupported).toEqual(['builder(): entries[0].ext', 'builder(): outDir'])
  })

  it('should refuse `hooks` and point at tsdown\'s own', () => {
    expect(() => resolveModuleOptions(cwd, {}, outDir, { hooks: { 'build:before': () => {} } } as never)).toThrow(`\`builder()\` does not take \`hooks\`. Use tsdown's own \`hooks\` in the tsdown config, or a plugin that emits extra files. ${guide('hooks-in-a-tsdown-config')}`)
  })

  it('should refuse a `build` or `unbuild` field of `package.json` alongside it', () => {
    expect(() => assertNoLegacyBuildConfig(cwd, { build: {} })).toThrow(`The \`build\` field of \`package.json\` configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and remove the field. ${guide('moving-from-buildconfigts')}`)
    expect(() => assertNoLegacyBuildConfig(cwd, { unbuild: {} })).toThrow('The `unbuild` field of `package.json`')
    expect(() => assertNoLegacyBuildConfig(cwd, {})).not.toThrow()
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
    await expect(setupBuilder(config, {}, {}, { legacy: false })).rejects.toThrow([
      '`builder()` sets these tsdown options itself, so the tsdown config must leave them out:',
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
      guide('options-builder-sets'),
    ].join('\n'))
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
    expect(resolveOutDir('/repo/mod', '../sibling-dist')).toBe('/repo/sibling-dist')
    expect(resolveOutDir('/repo/mod', '/repo/mod/.stub')).toBe('/repo/mod/.stub')
    for (const outDir of ['.', '..', '/repo', '/repo/mod', '../mod']) {
      expect(() => resolveOutDir('/repo/mod', outDir)).toThrow(`contains the module root; the build empties the output directory first. Use a directory inside the module such as \`dist\`. ${guide('output-directory')}`)
    }
  })
})

describe('createTsconfigResolver', () => {
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

  it('should read the root `compilerOptions` and `exclude` through `extends`, apart from tsconfigs in `.nuxt`', async () => {
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

    const derived = parse(await writeDerivedTsconfig(cwd, (await createTsconfigResolver(cwd)).root, {}))
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
    const derived = await writeDerivedTsconfig(cwd, (await createTsconfigResolver(cwd)).root, {})
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
