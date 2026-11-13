import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { satisfies } from 'verkit'
import { version as nuxtVersion } from 'nuxt/package.json'
import { consola } from 'consola'
import { basename, dirname, join, resolve } from 'pathe'
import { parseTsconfig } from 'get-tsconfig'
import { bundledEntries, entryName, formatUnsupportedOptions, loadBuildConfig, resolveOutDir, translateBuildConfig, warnDeprecatedBuildConfig } from '../src/build/build-config.ts'
import { exec } from 'tinyexec'
import { runtimeExternals } from '../src/build/runtime-externals.ts'
import { selfReferencePaths } from '../src/build/tsconfig.ts'
import { SERVER_ROUTES_STUB, createTsconfigResolver, declarationPaths, tsconfigPaths, writeDerivedTsconfig, writeServerRoutesStub } from '../src/rolldown/tsconfig.ts'
import { transformCss } from '../src/rolldown/stylesheets.ts'
import { rewriteRuntimeDeclarations } from '../src/build/aliases.ts'
import { checkLegacyCJSPaths, checkLegacyDeclarationPaths, checkMissingPaths, checkNode10DeclarationPaths, checkStaleTypesField } from '../src/build/deprecations.ts'
import { GUIDE_SECTIONS, guide } from '../src/build/guide.ts'
import { erasableSyntaxHint } from '../src/build/stub.ts'
import { findNonErasableSyntax, findUnresolvableImports } from '../src/build/loader.ts'
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
      expect(config.fileHasEntries).toBe(false)
      expect(config.field).toBe('build')
      expect(config.neverBundle.map(String)).toEqual(['/^a(?:\\/|$)/', '/^b(?:\\/|$)/'])
      expect(config.unsupported).toEqual([])

      await rm(join(dir, 'build.config.mjs'))
      await mkdir(join(dir, 'node_modules/unbuild'), { recursive: true })
      await writeFile(join(dir, 'node_modules/unbuild/package.json'), JSON.stringify({ name: 'unbuild', type: 'module', exports: './index.js' }))
      await writeFile(join(dir, 'node_modules/unbuild/index.js'), 'export const defineBuildConfig = config => config\n')
      await writeFile(join(dir, 'build.config.js'), `import { defineBuildConfig } from 'unbuild'\nexport default [defineBuildConfig({ externals: ['a'] }), { entries: ['src/utils'] }]\n`)
      expect(await loadBuildConfig(dir, {}, join(dir, 'dist'))).toMatchObject({ importsUnbuild: true, fileHasEntries: true, field: undefined, unsupported: ['build.config.js: an array of 2 configs'] })

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
        'Relative imports in module code need the file\'s extension, so Node can load the sources as they are:',
        '  - build.config.ts:1:21: `./options` (use `./options.ts`)',
        '  - src/lib/index.ts:1:24: `../../options` (use `../../options.ts`)',
        '  - src/module.ts:1:24: `./helper` (use `./helper.ts`)',
        '  - src/module.ts:2:24: `./lib` (use `./lib/index.ts`)',
        `Write each specifier as suggested. ${guide('import-extensions-in-module-code')}`,
      ].join('\n'))
      await writeFile(join(dir, 'extensions/build.config.ts'), `import options from './options.ts'\nexport default options\n`)
      expect((await loadBuildConfig(join(dir, 'extensions'), {}, join(dir, 'dist'))).neverBundle.map(String)).toEqual(['/^o(?:\\/|$)/'])

      expect(await loadBuildConfig(dir, {}, join(dir, 'dist'))).toMatchObject({ file: undefined, unsupported: [] })
      const fromPkg = await loadBuildConfig(dir, { unbuild: { externals: ['u'] }, build: { externals: ['b'] } }, join(dir, 'dist'))
      expect(fromPkg.neverBundle.map(String)).toEqual(['/^u(?:\\/|$)/'])

      const [self, alias] = (await loadBuildConfig(dir, { name: '@nuxt/image', imports: { '#image/*': './src/*.ts' } }, join(dir, 'dist'))).neverBundle
      expect(['@nuxt/image', '@nuxt/image/utils'].every(id => self!.test(id))).toBe(true)
      expect(self!.test('@nuxt/image/runtime/providers/ipx')).toBe(false)
      expect(alias!.test('#image/config')).toBe(true)
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
      const config = { ...translate({}), file: 'build.config.ts', importsUnbuild: true, fileHasEntries: true, ignoredHooks: ['build.config.ts: hooks[\'mkdist:entry:options\']'] }
      warnDeprecatedBuildConfig(config)
      warnDeprecatedBuildConfig({ ...config, importsUnbuild: false, fileHasEntries: false, ignoredHooks: [], field: 'unbuild' })
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        expect.stringMatching(new RegExp(`^Ignoring build\\.config\\.ts: hooks\\['mkdist:entry:options'\\]: .*Remove the hook\\. ${guide('hooks')}$`)),
        expect.stringMatching(new RegExp(`^\`build\\.config\\.ts\` is deprecated\\. .*instead of \`unbuild\`\\. Move \`entries\` to the \`build\\.entries\` field of \`package\\.json\`\\. ${guide('build-configuration')}$`)),
        `\`build.config.ts\` is deprecated. Its options are still applied. ${guide('build-configuration')}`,
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
  it('should link the missing tsdown and stub syntax hints to the upgrade guide', () => {
    expect(MISSING_TSDOWN_HINT).toMatch(new RegExp(`pnpm add -D tsdown@"\\^[\\d.]+"\`\\. ${guide('install-tsdown')}$`))
    expect(erasableSyntaxHint([]).endsWith(guide('stub-builds'))).toBe(true)
  })

  it('should locate every use of syntax that Node cannot strip across the imported sources', async () => {
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
        ``,
      ].join('\n'))
      await writeFile(join(dir, 'src/levels.ts'), `export enum Level { High = 'high' }\n`)
      await writeFile(join(dir, 'src/util.ts'), `export const asArray = (v: unknown) => <unknown[]>(Array.isArray(v) ? v : [v])\nexport function normalise(v: string) {\n  return <string>v.trim()\n}\n`)
      await writeFile(join(dir, 'src/context.ts'), `export class Context {\n  constructor(\n    public readonly name: string,\n    public options: object,\n  ) {}\n}\n`)
      await writeFile(join(dir, 'src/shared.ts'), `export const enum Mode { On }\n`)
      await writeFile(join(dir, 'src/types.ts'), `export interface Unused { never: true }\ndeclare module 'ambient' { enum Hidden { A } }\nexport enum Skipped { A }\n`)
      const expected = [
        { file: 'src/module.ts', line: 11, column: 15, kind: 'parameter property' },
        { file: 'src/module.ts', line: 11, column: 37, kind: 'parameter property' },
        { file: 'src/module.ts', line: 13, column: 22, kind: 'angle-bracket type assertion' },
        { file: 'src/levels.ts', line: 1, column: 1, kind: '`enum`' },
        { file: 'src/util.ts', line: 1, column: 40, kind: 'angle-bracket type assertion' },
        { file: 'src/util.ts', line: 3, column: 10, kind: 'angle-bracket type assertion' },
        { file: 'src/context.ts', line: 3, column: 5, kind: 'parameter property' },
        { file: 'src/context.ts', line: 4, column: 5, kind: 'parameter property' },
        { file: 'src/shared.ts', line: 1, column: 1, kind: '`enum`' },
      ]
      expect(findNonErasableSyntax(dir, ['./src/module.ts'])).toEqual(expected)
      expect(erasableSyntaxHint(expected)).toContain('  - src/util.ts:3:10: angle-bracket type assertion')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('findUnresolvableImports', () => {
  it('should list relative value imports Node cannot resolve as written, skipping runtime files but not what they import', async () => {
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
      expect(findUnresolvableImports(dir, ['./src/module.ts'], [join(dir, 'src/runtime')])).toEqual([
        { file: 'src/module.ts', line: 1, column: 21, specifier: './kit', suggestion: './kit/index.ts' },
        { file: 'src/module.ts', line: 2, column: 22, specifier: './util.js', suggestion: './util.ts' },
        { file: 'src/module.ts', line: 6, column: 20, specifier: './runtime/plugin', suggestion: './runtime/plugin.ts' },
        { file: 'src/module.ts', line: 9, column: 22, specifier: './more', suggestion: './more.ts' },
        { file: 'src/module.ts', line: 11, column: 34, specifier: './lazy', suggestion: './lazy.ts' },
        { file: 'src/ok.ts', line: 1, column: 24, specifier: './nested', suggestion: './nested.ts' },
        { file: 'src/aliased.ts', line: 1, column: 22, specifier: '../deep', suggestion: '../deep.ts' },
        { file: 'src/legacy.js', line: 1, column: 15, specifier: './leaf', suggestion: './leaf.ts' },
        { file: 'src/shared.ts', line: 1, column: 22, specifier: './tail', suggestion: './tail.ts' },
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
  it('should import JSON without attributes, with top-level keys as named exports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-json-'))
    await writeFile(join(dir, 'data.json'), '{"name":"x","default":1,"not-an-identifier":true,"__proto__":{"kept":true}}')
    await writeFile(join(dir, 'entry.ts'), `export * from './data.json'\nexport { default as data } from './data.json'\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const script = `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)}); console.log(JSON.stringify(await importModule(${JSON.stringify(join(dir, 'entry.ts'))})))`
    const { stdout } = await exec('node', ['--input-type=module', '-e', script])
    expect(JSON.parse(stdout)).toEqual(JSON.parse('{"name":"x","not-an-identifier":true,"__proto__":{"kept":true},"data":{"name":"x","default":1,"not-an-identifier":true,"__proto__":{"kept":true}}}'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should probe extensionless relative imports only inside runtime directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-probe-'))
    await mkdir(join(dir, 'runtime'))
    await writeFile(join(dir, 'helper.ts'), `export const value: string = 'module'\n`)
    await writeFile(join(dir, 'entry.ts'), `export { value } from './helper'\n`)
    await writeFile(join(dir, 'runtime/helper.ts'), `export const value: string = 'runtime'\n`)
    await writeFile(join(dir, 'runtime/entry.ts'), `export { value } from './helper'\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const script = [
      `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)})`,
      `const options = { runtimeDirs: [${JSON.stringify(join(dir, 'runtime'))}] }`,
      `const failure = await importModule(${JSON.stringify(join(dir, 'entry.ts'))}, options).then(() => 'loaded', error => error.code)`,
      `const runtime = await importModule(${JSON.stringify(join(dir, 'runtime/entry.ts'))}, options)`,
      `console.log(JSON.stringify([failure, runtime.value]))`,
    ].join('\n')
    const { stdout } = await exec('node', ['--input-type=module', '-e', script], { throwOnError: true })
    expect(JSON.parse(stdout)).toEqual(['ERR_MODULE_NOT_FOUND', 'runtime'])
    await rm(dir, { recursive: true, force: true })
  })

  it('should leave files that only need type stripping to Node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-strip-'))
    const line = `export const location: string = ((): string => new Error('here').stack!.split('\\n')[1]!)()`
    await writeFile(join(dir, 'entry.ts'), `${line}\nexport { kind } from './kind.ts'\n`)
    await writeFile(join(dir, 'kind.ts'), `export enum Kind { Stub = 'stub' }\nexport const kind: string = Kind.Stub\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const script = `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)}); const m = await importModule(${JSON.stringify(join(dir, 'entry.ts'))}); console.log(JSON.stringify([m.location, m.kind]))`
    const { stdout } = await exec('node', ['--input-type=module', '-e', script], { nodeOptions: { env: { ...process.env, CI: '1' } } })
    const [location, kind] = JSON.parse(stdout) as [string, string]
    expect(location).toContain(`entry.ts:1:${line.indexOf('new Error') + 1}`)
    expect(kind).toBe('stub')
    await rm(dir, { recursive: true, force: true })
  })

  it('should stand in for `#build` re-exports of `default` and of reserved words', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'module-builder-stub-'))
    await writeFile(join(dir, 'entry.ts'), `export { default as theme, for as loop } from '#build/ui/button'\nexport { size } from './size.ts'\n`)
    await writeFile(join(dir, 'size.ts'), `import { default as button, variants } from '#build/ui/button'\nexport const size = typeof button.slots + typeof variants\n`)
    const loader = fileURLToPath(new URL('../src/build/loader.ts', import.meta.url))
    const script = `const { importModule } = await import(${JSON.stringify(pathToFileURL(loader).href)}); const m = await importModule(${JSON.stringify(join(dir, 'entry.ts'))}); console.log(JSON.stringify([Object.keys(m).sort(), typeof m.theme, typeof m.loop, m.size]))`
    const { stdout, stderr } = await exec('node', ['--input-type=module', '-e', script])
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual([['loop', 'size', 'theme'], 'function', 'function', 'functionfunction'])
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
  }, 60 * 1000)

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
