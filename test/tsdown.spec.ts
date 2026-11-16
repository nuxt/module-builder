import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'pathe'
import { exec } from 'tinyexec'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

import { guide } from '../src/build/guide.ts'
import { npmPackFromPnpmScript, packProbeArgs, packProbeContext } from './pack-env.ts'
import { copyExample, repoRoot, tsdown, tsdownBin } from './utils.ts'

describe('builder', () => {
  let hooksDir: string

  beforeAll(async () => {
    hooksDir = await copyExample('.temp-tsdown-hooks', `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
    builder({ entries: ['./src/utils'] }),
  ],
}
`)
    await mkdir(join(hooksDir, 'node_modules/fake-ext'), { recursive: true })
    await writeFile(join(hooksDir, 'node_modules/fake-ext/package.json'), JSON.stringify({ name: 'fake-ext', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }))
    await writeFile(join(hooksDir, 'node_modules/fake-ext/index.js'), `export const ext = 'bundled-fake-ext'\n`)
    await writeFile(join(hooksDir, 'node_modules/fake-ext/index.d.ts'), `export declare const ext: string\n`)
    await mkdir(join(hooksDir, 'src/runtime/utils'), { recursive: true })
    await writeFile(join(hooksDir, 'src/runtime/utils/answer.ts'), `export const answer: number = 42\n`)
    await appendFile(join(hooksDir, 'src/module.ts'), [
      `import { generated } from './generated.ts'`,
      `import { ext } from 'fake-ext'`,
      `import { answer } from './runtime/utils/answer.ts'`,
      `export const refs: unknown[] = [generated, ext, answer, '__USER__']`,
      '',
    ].join('\n'))
  })

  it('should run the config\'s hooks before its own, so `build:prepare` can generate sources, and compose with its plugins and options', async () => {
    const { exitCode, stdout, stderr } = await tsdown(hooksDir)
    expect(stdout + stderr).not.toContain('Error')
    expect(exitCode).toBe(0)
    expect((await readFile(join(hooksDir, 'hooks.log'), 'utf-8')).trim().split('\n')).toEqual(['build:prepare', 'inputOptions', 'build:done true true'])
    expect(existsSync(join(hooksDir, 'dist/stale.txt'))).toBe(false)
    const module = await readFile(join(hooksDir, 'dist/module.mjs'), 'utf-8')
    expect(module).toContain('from build:prepare')
    expect(module).toContain('replaced by a user plugin')
    expect(module).toContain('from "fake-ext"')
    expect(module).not.toContain('bundled-fake-ext')
    expect(module).toContain('from "./runtime/utils/answer.js"')
    expect(JSON.parse(await readFile(join(hooksDir, 'dist/module.json'), 'utf-8'))).toMatchObject({ name: 'my-module', configKey: 'myModule' })
  })

  it('should write files a plugin emits before checking the paths of `package.json`', async () => {
    const dir = await copyExample('.temp-tsdown-emitted', `export default {\n  plugins: [\n    builder(),\n    { name: 'config', generateBundle() { this.emitFile({ type: 'asset', fileName: 'config.cjs', source: 'module.exports = {}\\n' }) } },\n  ],\n}\n`)
    const pkgPath = join(dir, 'package.json')
    const { typesVersions: _, ...pkg } = JSON.parse(await readFile(pkgPath, 'utf-8'))
    await writeFile(pkgPath, JSON.stringify({ ...pkg, exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' }, './config': './dist/config.cjs' } }, null, 2))
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).toBe(0)
    expect(stdout + stderr).not.toContain('do not exist after the build')
    expect(await readFile(join(dir, 'dist/config.cjs'), 'utf-8')).toBe('module.exports = {}\n')
  })

  it('should refuse to build when a published path points at a TypeScript source or at a file the pack leaves out', async () => {
    const dir = await copyExample('.temp-tsdown-unpublishable', `export default {\n  plugins: [builder()],\n}\n`)
    const pkgPath = join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
    const cases: Array<[Record<string, string>, string]> = [
      [{ '.': './src/module.ts' }, 'Pointing at TypeScript sources, which Node does not load from `node_modules`: `exports` (`./src/module.ts`).'],
      [{ '.': './lib/module.mjs' }, 'Pointing at paths that the pack leaves out: `exports` (`./lib/module.mjs`).'],
    ]
    for (const [exports, message] of cases) {
      await writeFile(pkgPath, JSON.stringify({ ...pkg, exports }, null, 2))
      for (const args of [[tsdownBin], [join(repoRoot, 'src/cli.ts'), 'build']]) {
        const { exitCode, stdout, stderr } = await exec('node', args, { nodeOptions: { cwd: dir, env: { ...process.env, NODE_ENV: '', TEST: '' } } })
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain(message)
        expect(existsSync(join(dir, 'dist'))).toBe(false)
      }
    }
  })

  it('should augment the same interfaces from the types `prepare` writes as from `dist`, through star re-exports', async () => {
    const dir = await copyExample('.temp-tsdown-star-exports', `export default {\n  plugins: [builder()],\n}\n`)
    const files: Record<string, string> = {
      'src/module.ts': `import { defineNuxtModule } from '@nuxt/kit'\nimport type { ModuleOptions } from './types/index.ts'\n\nexport * from './types/index.ts'\nexport type * from './types/runtime.ts'\n\nexport default defineNuxtModule<ModuleOptions>({\n  meta: { name: 'my-module', configKey: 'myModule' },\n  defaults: { apiKey: '' },\n})\n`,
      'src/types/index.ts': `export * from './hooks.ts'\n\nexport interface ModuleOptions {\n  apiKey: string\n}\n`,
      'src/types/hooks.ts': `export interface ModuleHooks {\n  'my-module:init': () => void\n}\n`,
      'src/types/runtime.ts': `export interface ModuleRuntimeHooks {\n  'my-module:runtime-hook': () => void\n}\n\nexport interface ModulePublicRuntimeConfig {\n  NAME: string\n}\n`,
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true })
      await writeFile(join(dir, file), contents)
    }
    const env = { ...process.env, NODE_ENV: '', TEST: '', NUXT_TELEMETRY_DISABLED: '1' }
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare'], { nodeOptions: { cwd: dir, env } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)

    const shims = async (file: string) => (await readFile(join(dir, file), 'utf-8')).match(/^declare module '[^']+' \{\n[\s\S]*?\n\}$/gm)
    const sourceShims = await shims('.nuxt/module-builder/types.d.mts')
    expect(sourceShims).toEqual(await shims('dist/types.d.mts'))
    expect(sourceShims).toEqual([
      `declare module '#app' {\n  interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}\n}`,
      `declare module '@nuxt/schema' {\n  interface NuxtHooks extends ModuleHooks {}\n  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}\n}`,
    ])

    const { config } = ts.readConfigFile(join(dir, '.nuxt/tsconfig.json'), ts.sys.readFile)
    const { options } = ts.parseJsonConfigFileContent(config, ts.sys, join(dir, '.nuxt'))
    for (const types of ['./.nuxt/module-builder/types.mjs', './dist/types.mjs']) {
      const probe = join(dir, 'probe.ts')
      await writeFile(probe, `import type {} from '${types}'\nimport type { RuntimeNuxtHooks } from '#app'\nimport type { NuxtHooks, PublicRuntimeConfig } from '@nuxt/schema'\n\nexport type Augmented = [NuxtHooks['my-module:init'], RuntimeNuxtHooks['my-module:runtime-hook'], PublicRuntimeConfig['NAME']]\n`)
      const program = ts.createProgram([probe], { ...options, noEmit: true, skipLibCheck: false })
      const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file && /^(?:src|dist|\.nuxt\/module-builder)\/|^probe\.ts$/.test(relative(dir, diagnostic.file.fileName)))
      expect(diagnostics.map(diagnostic => `${relative(dir, diagnostic.file!.fileName)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`), types).toEqual([])
    }
  })

  it('should refuse package `imports` that the output imports and that would not work once installed', async () => {
    const dir = await copyExample('.temp-tsdown-package-imports', `export default {\n  plugins: [builder({ externals: [/^#ext\\//] })],\n}\n`)
    const pkgPath = join(dir, 'package.json')
    const pkg = { ...JSON.parse(await readFile(pkgPath, 'utf-8')), imports: { '#ext/*': './src/ext/*.ts', '#internal/*': './src/internal/*.ts' } }
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
    await mkdir(join(dir, 'src/ext'), { recursive: true })
    await mkdir(join(dir, 'src/internal'), { recursive: true })
    await writeFile(join(dir, 'src/ext/value.ts'), `export const ext: string = 'ext'\n`)
    await writeFile(join(dir, 'src/internal/value.ts'), `export const internal: string = 'internal'\n`)
    await appendFile(join(dir, 'src/module.ts'), `export { ext } from '#ext/value'\nexport { internal } from '#internal/value'\nexport const label: string = '#internal/label'\n`)

    const refused = await tsdown(dir)
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stdout + refused.stderr).toContain(`The build output imports these \`imports\` of \`package.json\`, which would not work once installed. Pointing at TypeScript sources, which Node does not load from \`node_modules\`: \`#ext/*\` (\`./src/ext/*.ts\`).`)
    expect(await readFile(join(dir, 'dist/module.mjs'), 'utf-8')).toContain('"#ext/value"')

    await writeFile(pkgPath, JSON.stringify({ ...pkg, publishConfig: { imports: { '#ext/*': './dist/ext/*.mjs' } } }, null, 2))
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
  })

  it('should be published at `@nuxt/module-builder/tsdown`, not at the package root', async () => {
    const built = await exec('node', [tsdownBin], { nodeOptions: { cwd: repoRoot } })
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    const loaded = await exec('node', ['--input-type=module', '-e', `const root = await import('@nuxt/module-builder')\nconst { builder } = await import('@nuxt/module-builder/tsdown')\nconsole.log(JSON.stringify(['builder' in root, builder().name]))`], { nodeOptions: { cwd: repoRoot } })
    expect(JSON.parse(loaded.stdout)).toEqual([false, 'nuxt-module-builder'])
  })

  it('should prepare a module without `.nuxt` before building it', async () => {
    const dir = await copyExample('.temp-tsdown-auto-prepare', `export default {\n  plugins: [builder()],\n}\n`)
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const { exitCode, stdout, stderr } = await exec('node', [tsdownBin], { nodeOptions: { cwd: dir, env: { ...process.env, NODE_ENV: '', TEST: '', NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toContain(guide('preparing-nuxt'))
    expect(existsSync(join(dir, '.nuxt/tsconfig.json'))).toBe(true)
    expect(await readFile(join(dir, 'dist/runtime/composables/useAliasedApp.d.ts'), 'utf-8')).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
  })

  it('should prepare a module that lists its own package in `.nuxtrc` and `nuxt.config`, with or without `dist`', async () => {
    const dir = await copyExample('.temp-tsdown-self-listed', `export default {\n  plugins: [builder()],\n}\n`)
    const pkgPath = join(dir, 'package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'))
    await writeFile(pkgPath, JSON.stringify({ ...pkg, name: 'self-listed-module' }, null, 2))
    await appendFile(join(dir, '.nuxtrc'), '\nmodules[]=self-listed-module\n')
    await writeFile(join(dir, 'nuxt.config.ts'), `export default { modules: [['self-listed-module', { apiKey: 'from-config' }]] }\n`)
    await writeFile(join(dir, 'src/module.ts'), (await readFile(join(dir, 'src/module.ts'), 'utf-8')).replace('setup(_options, _nuxt) {', 'setup(_options, _nuxt) {\n    console.log(`[setup] ${_options.apiKey}`)'))
    const env = { ...process.env, NODE_ENV: '', TEST: '', NUXT_TELEMETRY_DISABLED: '1' }
    const references = async () => (await readFile(join(dir, '.nuxt/nuxt.node.d.ts'), 'utf-8')).split('\n').filter(line => line.includes('types="self-listed-module"') || line === '/// <reference path="module-builder/types.d.mts" />')

    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const built = await exec('node', [tsdownBin], { nodeOptions: { cwd: dir, env } })
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(built.stdout.match(/\[setup\] .*/g)).toEqual(['[setup] from-config'])
    expect(await references()).toEqual(['/// <reference path="module-builder/types.d.mts" />'])

    await writeFile(pkgPath, JSON.stringify({ ...pkg, name: 'self-listed-module', exports: { '.': './src/module.ts' }, main: './src/module.ts' }, null, 2))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare'], { nodeOptions: { cwd: dir, env } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    expect(prepared.stdout.match(/\[setup\] .*/g)).toEqual(['[setup] from-config'])
    expect(await references()).toEqual(['/// <reference path="module-builder/types.d.mts" />'])
  })

  it('should reject one plugin instance shared by two configs', async () => {
    const dir = await copyExample('.temp-tsdown-shared', `const plugin = builder()\n\nexport default [\n  { plugins: [plugin] },\n  { plugins: [plugin], outDir: 'dist-other' },\n]\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toContain('The same `builder()` plugin is used in more than one tsdown config.')
  })

  it.each([
    ['format', `{ format: 'cjs' }`],
    ['entry', `{ entry: { module: 'src/utils.ts' } }`],
    ['platform', `{ platform: 'browser' }`],
  ])('should fail when another plugin changes `%s`, which it sets', async (option, override) => {
    const dir = await copyExample(`.temp-tsdown-overridden-${option}`, `export default {\n  plugins: [builder(), { name: 'override', tsdownConfig: () => (${override}) }],\n}\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(new RegExp(`Another tsdown plugin changed \`${option}\`.*, which \`builder\\(\\)\` sets\\. ${guide('options-builder-sets')}`))
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })

  it('should fail when `outputOptions` changes the file names of the bundled entries', async () => {
    const dir = await copyExample('.temp-tsdown-entry-file-names', `export default {\n  outputOptions: { entryFileNames: '[name].js' },\n  plugins: [builder({ entries: ['./src/utils'] })],\n}\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toMatch(/The build did not emit `(module|utils)\.mjs`, `(module|utils)\.mjs`\./)
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })

  describe('with `package.json` pointing at the sources and `publishConfig` at `dist`', () => {
    let dir: string

    beforeAll(async () => {
      dir = await copyExample('.temp-tsdown-source-exports', `export default {\n  publint: true,\n  plugins: [builder({ entries: ['./src/utils'] })],\n}\n`)
      const pkgPath = join(dir, 'package.json')
      const { typesVersions: _, ...pkg } = JSON.parse(await readFile(pkgPath, 'utf-8'))
      await writeFile(pkgPath, JSON.stringify({
        ...pkg,
        exports: { '.': { types: './.nuxt/module-builder/types.d.mts', default: './src/module.ts' }, './utils': './src/utils.ts' },
        main: './src/module.ts',
        types: './.nuxt/module-builder/types.d.mts',
        scripts: { prepack: 'node ../node_modules/tsdown/dist/run.mjs' },
        publishConfig: {
          exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' }, './utils': { types: './dist/utils.d.mts', default: './dist/utils.mjs' } },
          main: './dist/module.mjs',
          types: './dist/types.d.mts',
          typesVersions: { '*': { utils: ['./dist/utils.d.mts'] } },
        },
      }, null, 2))
      await rm(join(dir, 'playground/node_modules/my-module'), { force: true })
      await symlink(dir, join(dir, 'playground/node_modules/my-module'))
      for (const nuxtDir of ['.nuxt', 'playground/.nuxt']) {
        await rm(join(dir, nuxtDir), { recursive: true, force: true })
      }
      await writeFile(join(dir, 'src/module.ts'), (await readFile(join(dir, 'src/module.ts'), 'utf-8')).replace(`import type { SharedTypeFromRuntime } from './runtime/plugins/plugin'`, `type SharedTypeFromRuntime = 'shared-type'`))
    })

    const nuxtEnv = { ...process.env, NUXT_TELEMETRY_DISABLED: '1' }
    const typecheckPlayground = (context: string) => exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['--noEmit', '-p', join(dir, `playground/.nuxt/tsconfig.${context}.json`)], { nodeOptions: { cwd: dir } })

    it('should let the playground load the module and its type augmentations from its sources, without `dist`', async () => {
      const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare'], { nodeOptions: { cwd: dir, env: nuxtEnv } })
      expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
      const { exitCode, stdout, stderr } = await exec('node', [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'prepare', 'playground'], { nodeOptions: { cwd: dir, env: nuxtEnv } })
      expect(exitCode, stdout + stderr).toBe(0)
      expect(existsSync(join(dir, 'dist'))).toBe(false)
      expect(await readFile(join(dir, 'playground/.nuxt/types/plugins.d.ts'), 'utf-8')).toContain('src/runtime/plugins/plugin')

      for (const context of ['app', 'node']) {
        const typecheck = await typecheckPlayground(context)
        expect(typecheck.stdout + typecheck.stderr, context).toBe('')
        expect(typecheck.exitCode, context).toBe(0)
      }

      const pkgPath = join(dir, 'package.json')
      const pkg = await readFile(pkgPath, 'utf-8')
      await writeFile(pkgPath, pkg.replaceAll('./.nuxt/module-builder/types.d.mts', './src/module.ts'))
      try {
        const [app, node] = await Promise.all(['app', 'node'].map(typecheckPlayground))
        expect(app!.stdout).toContain(`'"my-module:runtime-hook"' is not assignable`)
        expect(node!.stdout).toContain(`''my-module:init'' does not exist`)
      }
      finally {
        await writeFile(pkgPath, pkg)
      }
    })

    it('should refuse to build for a pack by npm, which publishes the source paths', async () => {
      const { exitCode, stdout, stderr } = await exec('node', [...packProbeArgs, tsdownBin], { nodeOptions: { cwd: dir, env: { ...npmPackFromPnpmScript(), NODE_ENV: '', TEST: '' } } })
      expect(exitCode, `${packProbeContext()}\n${stdout}${stderr}`).not.toBe(0)
      expect(stdout + stderr).toMatch(/`npm(?:@[\d.]+)?` packs these fields of `package\.json` as written, and they point at TypeScript sources or paths that `files` leaves out: `exports`, `main`, `types` \(`\.\/\.nuxt\/module-builder\/types\.d\.mts`, `\.\/src\/module\.ts`, `\.\/src\/utils\.ts`\)\./)
      expect(stdout + stderr).toContain(guide('publishing-source-exports'))
    })

    it('should check the published paths of `package.json` after a build', async () => {
      const { exitCode, stdout, stderr } = await tsdown(dir)
      expect(exitCode).toBe(0)
      expect(stdout + stderr).not.toContain('package.json')
      expect(stdout + stderr).toContain('[publint] No issues found')

      const pkgPath = join(dir, 'package.json')
      const pkg = await readFile(pkgPath, 'utf-8')
      await writeFile(pkgPath, pkg.replace('"./dist/utils.mjs"', '"./dist/missing.mjs"'))
      try {
        const broken = await tsdown(dir)
        expect(broken.stdout + broken.stderr).toMatch(/do not exist after the build.*\.\/dist\/missing\.mjs/)
      }
      finally {
        await writeFile(pkgPath, pkg)
      }
    })

    it('should pack `dist` paths that attw accepts', async () => {
      const destination = join(dir, '.pack')
      const packed = await exec('pnpm', ['pack', '--pack-destination', destination], { nodeOptions: { cwd: dir } })
      expect(packed.exitCode, packed.stdout + packed.stderr).toBe(0)
      const tarball = join(destination, 'my-module-1.0.0.tgz')
      await exec('tar', ['-xzf', tarball, '-C', destination, 'package/package.json'], { throwOnError: true })
      expect(JSON.parse(await readFile(join(destination, 'package/package.json'), 'utf-8'))).toMatchObject({
        exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' } },
        main: './dist/module.mjs',
        types: './dist/types.d.mts',
      })
      const attw = await exec(join(repoRoot, 'node_modules/.bin/attw'), [tarball, '--ignore-rules', 'cjs-resolves-to-esm'], { nodeOptions: { cwd: dir } })
      expect(attw.exitCode, attw.stdout + attw.stderr).toBe(0)
    })
  })

  it('should fail when `build.config.ts` configures the build too', async () => {
    const dir = await copyExample('.temp-tsdown-legacy', `export default {\n  plugins: [builder()],\n}\n`)
    await writeFile(join(dir, 'build.config.ts'), `export default {}\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toContain(`\`build.config.ts\` configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and delete the file. ${guide('moving-from-buildconfigts')}`)
  })
})
