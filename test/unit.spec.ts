import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { satisfies } from 'verkit'
import { version as nuxtVersion } from 'nuxt/package.json'
import { consola } from 'consola'
import { dirname, join } from 'pathe'
import { parseTsconfig } from 'get-tsconfig'
import { runtimeExternals } from '../src/build/runtime-externals.ts'
import { selfReferencePaths } from '../src/build/tsconfig.ts'
import { SERVER_ROUTES_STUB, createTsconfigResolver, declarationPaths, tsconfigPaths, writeDerivedTsconfig } from '../src/rolldown/tsconfig.ts'
import { transformCss } from '../src/rolldown/stylesheets.ts'
import { rewriteRuntimeDeclarations } from '../src/build/aliases.ts'
import { checkLegacyCJSPaths, checkLegacyDeclarationPaths, checkStaleTypesField } from '../src/build/deprecations.ts'
import { guide } from '../src/build/guide.ts'

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

  it('should warn about a stale `types` field', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    expect(checkStaleTypesField(cwd, { types: './dist/nope.d.ts' })).toBe(true)
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`^Remove the \`types\` field from \`package\\.json\`: it points at \`\\./dist/nope\\.d\\.ts\`.* ${guide('the-types-field')}$`)))
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

describe('createTsconfigResolver', () => {
  it('should rebuild a tsconfig that takes its types from a playground on the module\'s own `.nuxt`, keeping its other options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'module-builder-foreign-'))
    await mkdir(join(cwd, '.nuxt'))
    await mkdir(join(cwd, 'playground/.nuxt'), { recursive: true })
    await writeFile(join(cwd, '.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], paths: { '#build/*': ['./*'], '#shared': ['../shared'] } }, include: ['./nuxt.d.ts', '../src/**/*'] }))
    await writeFile(join(cwd, 'playground/.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { types: ['playground-types'], paths: { '#build/*': ['./*'], '#playground': ['../app'] } }, include: ['../**/*'] }))
    await writeFile(join(cwd, 'base.json'), JSON.stringify({ compilerOptions: { types: ['global-types'], noUncheckedIndexedAccess: true } }))
    await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ extends: ['./base.json', './playground/.nuxt/tsconfig.json'], compilerOptions: { paths: { '#shared': ['./other'], '#mine/*': ['./mine/*'] }, exactOptionalPropertyTypes: true }, references: [{ path: './playground/.nuxt/tsconfig.app.json' }, { path: './tsconfig.node.json' }] }))
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
