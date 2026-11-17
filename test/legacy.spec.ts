import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { consola } from 'consola'
import { findStaticImports } from 'mlly'
import { join, relative } from 'pathe'
import ts from 'typescript'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { bundledEntries, entryName } from '../src/build/options.ts'
import { assertNoLegacyBuildConfig, formatUnsupportedOptions, loadBuildConfig, translateBuildConfig, warnDeprecatedBuildConfig } from '../src/legacy/build-config.ts'
import { guide } from '../src/build/guide.ts'
import type { FixtureOptions, Result } from './utils.ts'
import { cli, exists, fixture, listFiles, read, repoRoot, tsdown } from './utils.ts'

const exampleDir = fileURLToPath(new URL('../example', import.meta.url))

describe('translateBuildConfig', () => {
  const cwd = exampleDir
  const outDir = join(cwd, 'dist')
  const translate = (...configs: unknown[]) => translateBuildConfig(configs.map((config, index) => ({ name: `config${index}`, config })), { cwd, outDir })

  it('should name entries the way unbuild did', () => {
    expect(entryName('src/vite', cwd)).toBe('vite')
    expect(entryName('./src/runtime/server/index.ts', cwd)).toBe('runtime/server/index')
    expect(entryName(join(cwd, 'src/cli.mts'), cwd)).toBe('cli')
    expect(entryName('lib/other', cwd)).toBe('lib/other')
  })

  it('should resolve entry inputs to their source file, without duplicating the module entry', () => {
    expect(translate({ entries: ['src/utils', { input: './src/utils.ts', name: 'helpers' }] }).entries).toEqual({
      utils: './src/utils.ts',
      helpers: './src/utils.ts',
    })
    expect(bundledEntries(cwd, translate({ entries: ['src/module'] }))).toEqual({ module: './src/module.ts' })
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
    expect(translate(
      { rollup: { replace: { values: { A: 'a' }, preventAssignment: false, objectGuards: true } } },
      { rollup: { replace: { preventAssignment: true, objectGuards: false } } },
    ).replace).toEqual({ values: { A: 'a' }, preventAssignment: false, objectGuards: true })
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

describe('loadBuildConfig', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'module-builder-'))
    return () => rm(dir, { recursive: true, force: true })
  })

  it('should load a config file, then `package.json`', async () => {
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

    expect(await loadBuildConfig(dir, {}, join(dir, 'dist'))).toMatchObject({ file: undefined, unsupported: [] })
    const fromPkg = await loadBuildConfig(dir, { unbuild: { externals: ['u'] }, build: { externals: ['b'] } }, join(dir, 'dist'))
    expect(fromPkg.neverBundle.map(String)).toEqual(['/^u(?:\\/|$)/'])

    const inferred = (await loadBuildConfig(dir, { name: '@nuxt/image', imports: { '#image/*': './src/*.ts' } }, join(dir, 'dist'))).neverBundle
    expect(inferred).toHaveLength(1)
    expect(['@nuxt/image', '@nuxt/image/utils'].every(id => inferred[0]!.test(id))).toBe(true)
    expect(inferred[0]!.test('@nuxt/image/runtime/providers/ipx')).toBe(false)
  })

  it('should list the imports of a config file and of the module code that Node cannot resolve', async () => {
    const root = join(dir, 'extensions')
    await mkdir(join(root, 'src/lib'), { recursive: true })
    await writeFile(join(root, 'options.ts'), `export default { externals: ['o'] }\n`)
    await writeFile(join(root, 'build.config.ts'), `import options from './options'\nexport default options\n`)
    await writeFile(join(root, 'src/module.ts'), `import { helper } from './helper'\nexport { shared } from './lib'\nexport default helper\n`)
    await writeFile(join(root, 'src/helper.ts'), `export const helper = 1\n`)
    await writeFile(join(root, 'src/lib/index.ts'), `import { shared } from '../../options'\nexport { shared }\n`)
    await expect(loadBuildConfig(root, { build: { entries: ['src/lib/index'] } }, join(root, 'dist'))).rejects.toThrow([
      'Module code has to load with Node, which strips types and resolves imports as written:',
      '  - build.config.ts:1:21: `./options` (use `./options.ts`)',
      '  - src/lib/index.ts:1:24: `../../options` (use `../../options.ts`)',
      '  - src/module.ts:1:24: `./helper` (use `./helper.ts`)',
      '  - src/module.ts:2:24: `./lib` (use `./lib/index.ts`)',
      `Change each one as suggested. ${guide('module-code-loads-with-node')}`,
    ].join('\n'))
    await writeFile(join(root, 'build.config.ts'), `import options from './options.ts'\nexport default options\n`)
    expect((await loadBuildConfig(root, {}, join(root, 'dist'))).neverBundle.map(String)).toEqual(['/^o(?:\\/|$)/'])
  })
})

describe('assertNoLegacyBuildConfig', () => {
  it('should refuse a `build` or `unbuild` field of `package.json` alongside `builder()`', () => {
    expect(() => assertNoLegacyBuildConfig(exampleDir, { build: {} })).toThrow(`The \`build\` field of \`package.json\` configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and remove the field. ${guide('moving-from-buildconfigts')}`)
    expect(() => assertNoLegacyBuildConfig(exampleDir, { unbuild: {} })).toThrow('The `unbuild` field of `package.json`')
    expect(() => assertNoLegacyBuildConfig(exampleDir, {})).not.toThrow()
  })
})

describe('deprecations in the editor', () => {
  it('should mark `defineBuildConfig()`', () => {
    const file = join(repoRoot, 'test/__deprecations__.ts')
    const source = [
      `import { defineBuildConfig } from '../src/index.ts'`,
      `defineBuildConfig({ entries: ['./src/utils'] })`,
    ].join('\n')
    const options: ts.CompilerOptions = {
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2024,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    }
    const service = ts.createLanguageService({
      getScriptFileNames: () => [file],
      getScriptVersion: () => '1',
      getScriptSnapshot: name => name === file ? ts.ScriptSnapshot.fromString(source) : ts.sys.fileExists(name) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(name)!) : undefined,
      getCurrentDirectory: () => repoRoot,
      getCompilationSettings: () => options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: name => name === file || ts.sys.fileExists(name),
      readFile: name => name === file ? source : ts.sys.readFile(name),
    })
    expect(service.getSemanticDiagnostics(file).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
    const deprecated = service.getSuggestionDiagnostics(file)
      .filter(diagnostic => diagnostic.reportsDeprecated)
      .map(diagnostic => ({
        name: source.slice(diagnostic.start, diagnostic.start! + diagnostic.length!),
        advice: ts.displayPartsToString(service.getQuickInfoAtPosition(file, diagnostic.start!)?.tags?.find(tag => tag.name === 'deprecated')?.text),
      }))
    expect(deprecated).toEqual(Array.from({ length: 2 }, () => ({
      name: 'defineBuildConfig',
      advice: expect.stringMatching(/`builder\(\)` from `@nuxt\/module-builder\/tsdown`, in `tsdown\.config\.ts`/),
    })))
  })
})

describe('nuxt-module-build build without a tsdown config', () => {
  const LEGACY_TSCONFIG = { extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground'] }
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
  const hashes = async (dir: string) => {
    const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(file => file.isFile())
    return Object.fromEntries(await Promise.all(files.map(async (file) => {
      const path = join(file.parentPath, file.name)
      return [relative(dir, path), createHash('sha256').update(await readFile(path)).digest('hex')] as const
    })))
  }

  const withoutBuildConfig = ({ 'build.config.ts': _, ...files }: NonNullable<FixtureOptions['files']>) => files

  beforeAll(async () => {
    const base = await fixture('.temp-legacy/base', { config: false, files: { 'tsconfig.json': JSON.stringify(LEGACY_TSCONFIG) } })
    const prepared = await cli(['prepare', base])
    expect(prepared.exitCode, prepared.output).toBe(0)

    const buildConfig: FixtureOptions = {
      from: base,
      config: false,
      pkg: pkg => ({
        ...pkg,
        imports: { '#content-alias/*': './src/alias/*.ts' },
        publishConfig: { imports: { '#content-alias/*': './dist/alias/*.mjs' } },
        build: { entries: [{ input: 'src/features/', outDir: 'dist/features', ext: 'js' }] },
      }),
      files: {
        'build.config.ts': `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineBuildConfig } from '@nuxt/module-builder'
import { externals } from './build/externals.ts'

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
        'src/vite.ts': `// @ts-ignore untyped\nimport { plugin } from 'fake-pkg/sub'\n// @ts-ignore untyped\nimport virtual from 'regex-pkg'\n\nimport { generated } from './generated.ts'\n\ndeclare const __MODULE_VERSION__: string\n\nexport const version: string = __MODULE_VERSION__\nexport const refs: unknown[] = [plugin, virtual, generated]\n`,
        'src/content.ts': `// @ts-ignore build-time alias\nimport config from '#content-alias/config'\n\nexport const content: unknown = config\n`,
        'src/nested/helper.ts': `import plugin from '../runtime/plugins/plugin.ts'\n\nexport const helper = (): unknown => plugin\nexport const lazy = (): Promise<unknown> => import('../runtime/composables/useWrappedFetch.ts')\n`,
        'src/shared/format.ts': `export const format = (value: string): string => value.trim()\n`,
        'src/features/flag.ts': `export const flag: boolean = true\n`,
      },
    }
    dirs.buildConfig = await fixture('.temp-legacy/build-config', buildConfig)
    dirs.buildConfigEjected = await fixture('.temp-legacy/build-config-ejected', {
      ...buildConfig,
      config: `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { externals } from './build/externals.ts'

export default {
  hooks: {
    'build:prepare'(ctx) {
      writeFileSync(join(ctx.options.cwd, 'src/generated.ts'), 'export const generated = "from build:before"\\n')
    },
  },
  plugins: [builder({
    entries: ['src/utils', './src/vite.ts', { input: 'src/content', name: 'content' }, 'src/nested/helper', { input: 'src/shared/', outDir: 'dist/shared' }, { input: 'src/features/', outDir: 'dist/features', ext: 'js' }],
    externals,
    replace: { __MODULE_VERSION__: JSON.stringify('1.2.3') },
  })],
}
`,
      pkg: pkg => ({ ...buildConfig.pkg!(pkg), build: undefined }),
      files: withoutBuildConfig(buildConfig.files!),
    })

    const replace: FixtureOptions = {
      from: base,
      config: false,
      module: source => [
        `import type { NuxtModule } from '@nuxt/schema'`,
        source.replace(/export default defineNuxtModule(<ModuleOptions>)?\(\{/, (_, options = '') => `const module: NuxtModule${options} = defineNuxtModule${options}({`),
        'export default module',
      ].join('\n'),
      pkg: pkg => ({ ...pkg, unbuild: { externals: ['ext-pkg'] } }),
      files: {
        'tsconfig.json': JSON.stringify({ ...LEGACY_TSCONFIG, compilerOptions: { isolatedDeclarations: true } }),
        'src/utils.ts': 'export const myModuleUtils = (): void => {}\n',
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
        'src/unplugin.ts': `// @ts-ignore untyped\nimport ext from 'ext-pkg'\n\ndeclare const process: { argv: string[] }\n\nexport const isDev: boolean = process.argv.includes('--uiDev')\nexport const extRef: unknown = ext\n`,
        'node_modules/ext-pkg/package.json': JSON.stringify({ name: 'ext-pkg', type: 'module', exports: './index.js' }),
        'node_modules/ext-pkg/index.js': `export default 'bundled-ext-pkg'\n`,
      },
    }
    dirs.replace = await fixture('.temp-legacy/replace', replace)
    dirs.replaceEjected = await fixture('.temp-legacy/replace-ejected', {
      ...replace,
      config: `export default {\n  plugins: [builder({\n    entries: ['./src/unplugin'],\n    externals: ['#build/ui', 'ext-pkg'],\n    replace: { delimiters: ['', ''], values: { "process.argv.includes('--uiDev')": 'false' } },\n  })],\n}\n`,
      pkg: undefined,
      files: withoutBuildConfig(replace.files!),
    })

    dirs.unsupported = await fixture('.temp-legacy/unsupported', {
      from: base,
      config: false,
      files: {
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
      },
    })

    dirs.example = await fixture('.temp-legacy/example', { config: false })
    dirs.exampleEjected = await fixture('.temp-legacy/example-ejected')
    dirs.withField = await fixture('.temp-legacy/with-field', { config: 'export default {\n  plugins: [builder()],\n}\n', pkg: pkg => ({ ...pkg, build: { entries: ['./src/utils'] } }) })
    dirs.withFile = await fixture('.temp-legacy/with-file', { config: 'export default {\n  plugins: [builder()],\n}\n', files: { 'build.config.ts': 'export default {}\n' } })

    await Promise.all([
      step('buildConfig', cli(['build', dirs.buildConfig], { CI: '' })),
      step('buildConfigEjected', tsdown(dirs.buildConfigEjected)),
      step('replace', cli(['build', dirs.replace])),
      step('replaceEjected', tsdown(dirs.replaceEjected)),
      step('unsupported', cli(['build', dirs.unsupported])),
      step('example', cli(['build', dirs.example])),
      step('exampleEjected', tsdown(dirs.exampleEjected)),
      step('withField', cli(['build', dirs.withField])),
      step('withField:prepare', cli(['prepare', dirs.withField])),
      step('withFile', tsdown(dirs.withFile)),
    ])
  })

  it('should build `build.config.ts` entries under the names unbuild gave them, alongside the `build` field of `package.json`', async () => {
    expectBuilt('buildConfig')
    expect((await listFiles(join(dirs.buildConfig!, 'dist'))).filter(file => !file.startsWith('runtime'))).toMatchInlineSnapshot(`
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
    const helper = await read(dirs.buildConfig!, 'dist/nested/helper.mjs')
    expect(findStaticImports(helper).map(i => i.specifier)).toEqual(['../runtime/plugins/plugin.js'])
    expect(helper).toContain('import("../runtime/composables/useWrappedFetch.js")')
    expect(helper).not.toContain(dirs.buildConfig)
  })

  it('should run `build.config.ts` hooks in order with the build context', async () => {
    const log = (await read(dirs.buildConfig!, 'hooks.log')).trim().split('\n').map(line => JSON.parse(line))
    expect(log.slice(0, 3)).toEqual([
      expect.objectContaining({ hook: 'build:before', stub: false }),
      expect.objectContaining({ hook: 'rollup:done', stub: false, meta: true }),
      expect.objectContaining({ hook: 'build:done', stub: false, meta: true }),
    ])
    expect(log[0].entries).toEqual(['content', 'features', 'module', 'nested/helper', 'runtime', 'shared', 'utils', 'vite'])
    expect(await read(dirs.buildConfig!, 'dist/vite.mjs')).toContain('from build:before')
  })

  it('should keep `build.config.ts` externals external and apply its replacements', async () => {
    const vite = await read(dirs.buildConfig!, 'dist/vite.mjs')
    expect(vite).toContain('from "fake-pkg/sub"')
    expect(vite).toContain('from "regex-pkg"')
    expect(vite).toContain('"1.2.3"')
    expect(vite).not.toContain('__MODULE_VERSION__')
    const content = await read(dirs.buildConfig!, 'dist/content.mjs')
    expect(content).toContain('from "#content-alias/config"')
    expect(vite + content).not.toContain('bundled-')
  })

  it('should warn that `build.config.ts` is deprecated', () => {
    const output = expectBuilt('buildConfig')
    expect(output).toMatch(new RegExp(`\`?build\\.config\\.ts\`? is deprecated\\. Its options are still applied\\. Move them into \`?builder\\(\\)\`? in \`?tsdown\\.config\\.ts\`?\\. ${guide('moving-from-buildconfigts')}`))
    expect(output).not.toMatch(/`?unbuild`? field/)
  })

  it('should read the `unbuild` field of `package.json` in preference to `build`, with the replacements of `rollup.replace`', async () => {
    expectBuilt('replace')
    const unplugin = await read(dirs.replace!, 'dist/unplugin.mjs')
    expect(unplugin).toContain('from "ext-pkg"')
    expect(unplugin).not.toContain('bundled-ext-pkg')
    expect(unplugin).not.toContain('--uiDev')
    expect(unplugin).toMatch(/isDev = false/)
    expect(exists(dirs.replace!, 'dist/utils.mjs')).toBe(false)
  })

  it('should fail on every `build.config.ts` option without an equivalent', () => {
    const output = expectFailed('unsupported')
    for (const option of ['entries[0].ext', 'entries[1].builder: \'untyped\'', 'hooks[\'build:prepare\']', 'hooks[\'rollup:options\']', 'rollup.emitCJS: true', 'rollup.alias', 'stub', 'unknownOption']) {
      expect(output).toContain(`build.config.ts: ${option}`)
    }
    expect(output).not.toContain('build.config.ts: hooks[\'mkdist:entry:options\']')
    expect(output).toContain(`build.config.ts: rollup.emitCJS: true (${guide('commonjs-output')})`)
    expect(output).toContain(guide('unsupported-build-options'))
  })

  it('should build the same `dist` as `tsdown` with `builder()` and the same options', async () => {
    for (const [legacy, ejected] of [['example', 'exampleEjected'], ['buildConfig', 'buildConfigEjected'], ['replace', 'replaceEjected']] as const) {
      expectBuilt(legacy)
      expectBuilt(ejected)
      const built = await hashes(join(dirs[legacy]!, 'dist'))
      expect(Object.keys(built), legacy).toContain('module.json')
      expect(await hashes(join(dirs[ejected]!, 'dist')), legacy).toEqual(built)
    }
  })

  it('should fail when `package.json` or `build.config.ts` configures the build alongside `builder()`', () => {
    for (const name of ['withField', 'withField:prepare']) {
      expect(expectFailed(name), name).toContain('The `build` field of `package.json` configures the build, and so does `builder()` in the tsdown config.')
    }
    expect(expectFailed('withFile')).toContain(`\`build.config.ts\` configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and delete the file. ${guide('moving-from-buildconfigts')}`)
  })
})
