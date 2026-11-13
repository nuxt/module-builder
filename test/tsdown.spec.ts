import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'pathe'
import { exec } from 'tinyexec'
import { beforeAll, describe, expect, it } from 'vitest'

import { guide } from '../src/build/guide.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exampleDir = join(repoRoot, 'example')
const tsdownBin = join(repoRoot, 'node_modules/tsdown/dist/run.mjs')
const builderImport = `import { builder } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src/tsdown/index.ts')).href)}`

async function copyExample(name: string, config: string) {
  const dir = join(repoRoot, name)
  await rm(dir, { recursive: true, force: true })
  await cp(exampleDir, dir, { recursive: true })
  await rm(join(dir, 'dist'), { recursive: true, force: true })
  const pkgPath = join(dir, 'package.json')
  const { build: _, ...pkg } = JSON.parse(await readFile(pkgPath, 'utf-8'))
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\n${config}`)
  return dir
}

const tsdown = (cwd: string, args: string[] = []) => exec('node', [tsdownBin, ...args], { nodeOptions: { cwd, env: { ...process.env, NODE_ENV: '', TEST: '' } } })

function watch(cwd: string, args: string[]) {
  const result = exec('node', args, { nodeOptions: { cwd, env: { ...process.env, NODE_ENV: '', TEST: '' } } })
  let output = ''
  for (const stream of [result.process?.stdout, result.process?.stderr]) {
    stream?.on('data', (chunk) => {
      output += chunk
    })
  }
  return {
    output: () => output,
    async stop() {
      result.kill()
      await result.then(() => {}, () => {})
    },
  }
}

async function waitFor(check: () => Promise<boolean>, timeout = 60_000) {
  const end = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > end) {
      throw new Error('Timed out')
    }
    await delay(250)
  }
}

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
        return id.endsWith('src/module.ts') ? code.replace('__USER__', 'replaced by a user plugin') : undefined
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
  }, 60 * 1000)

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
  }, 120 * 1000)

  it('should write files a plugin emits before checking the paths of `package.json`', async () => {
    const dir = await copyExample('.temp-tsdown-emitted', `export default {\n  plugins: [\n    builder(),\n    { name: 'config', generateBundle() { this.emitFile({ type: 'asset', fileName: 'config.cjs', source: 'module.exports = {}\\n' }) } },\n  ],\n}\n`)
    const pkgPath = join(dir, 'package.json')
    const { typesVersions: _, ...pkg } = JSON.parse(await readFile(pkgPath, 'utf-8'))
    await writeFile(pkgPath, JSON.stringify({ ...pkg, exports: { '.': { types: './dist/types.d.mts', default: './dist/module.mjs' }, './config': './dist/config.cjs' } }, null, 2))
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).toBe(0)
    expect(stdout + stderr).not.toContain('do not exist after the build')
    expect(await readFile(join(dir, 'dist/config.cjs'), 'utf-8')).toBe('module.exports = {}\n')
  }, 60 * 1000)

  it('should not keep more memory with each watched rebuild', async () => {
    const dir = await copyExample('.temp-tsdown-watch-memory', '')
    await rm(join(dir, 'tsdown.config.ts'))
    const file = join(dir, 'src/runtime/composables/useWrappedFetch.ts')
    await mkdir(join(dir, 'src/shared'), { recursive: true })
    await writeFile(join(dir, 'src/shared/format.ts'), `export const format = (value: string): string => value.trim()\n`)
    await writeFile(join(dir, 'watch.mjs'), [
      `import { readFileSync, writeFileSync } from 'node:fs'`,
      `import { build } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'node_modules/tsdown/dist/index.mjs')).href)}`,
      builderImport,
      `const source = readFileSync(${JSON.stringify(file)}, 'utf8')`,
      `let built`,
      `const handle = await build({ cwd: ${JSON.stringify(dir)}, config: false, watch: true, logLevel: 'silent', plugins: [builder({ entries: [{ input: 'src/shared/', outDir: 'dist/shared' }] }), { name: 'built', writeBundle: { order: 'post', handler: () => setTimeout(built, 100) } }] })`,
      `const heap = []`,
      `for (let round = 0; round < 6; round++) {`,
      `  await new Promise(resolve => { built = resolve; writeFileSync(${JSON.stringify(file)}, source + 'export const round = ' + round + '\\n') })`,
      `  globalThis.gc()`,
      `  heap.push(process.memoryUsage().heapUsed)`,
      `}`,
      `await handle.watch.close()`,
      `console.log(JSON.stringify(heap))`,
      `process.exit(0)`,
      '',
    ].join('\n'))
    const { stdout, exitCode } = await exec('node', ['--expose-gc', 'watch.mjs'], { nodeOptions: { cwd: dir, env: { ...process.env, NODE_ENV: '', TEST: '' } } })
    expect(exitCode).toBe(0)
    const heap = JSON.parse(stdout.trim().split('\n').at(-1)!) as number[]
    expect(heap.at(-1)! - heap[2]!).toBeLessThan(64 * 1024 * 1024)
  }, 180 * 1000)

  it('should rewrite `module.json` when a file the module entry imports changes while watching', async () => {
    const dir = await copyExample('.temp-tsdown-watch-imports', '')
    await rm(join(dir, 'tsdown.config.ts'))
    await writeFile(join(dir, 'src/runtime/name.ts'), `export const moduleName: string = 'from-runtime'\n`)
    const source = await readFile(join(dir, 'src/module.ts'), 'utf-8')
    await writeFile(join(dir, 'src/module.ts'), `import { moduleName } from './runtime/name.ts'\n${source.replace(`name: 'my-module'`, 'name: moduleName')}`)
    await writeFile(join(dir, 'watch.mjs'), [
      `import { build } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'node_modules/tsdown/dist/index.mjs')).href)}`,
      builderImport,
      `await build({ cwd: ${JSON.stringify(dir)}, config: false, watch: true, plugins: [builder()] })`,
      '',
    ].join('\n'))
    const meta = join(dir, 'dist/module.json')
    const watcher = watch(dir, ['watch.mjs'])
    try {
      await waitFor(async () => existsSync(meta) && JSON.parse(await readFile(meta, 'utf-8')).name === 'from-runtime')
      await writeFile(join(dir, 'src/runtime/name.ts'), `export const moduleName: string = 'changed-runtime'\n`)
      await waitFor(async () => JSON.parse(await readFile(meta, 'utf-8')).name === 'changed-runtime')
    }
    finally {
      await watcher.stop()
    }
  }, 120 * 1000)

  it.each([['an existing', 'existing'], ['a missing', 'missing']])('should rebuild when a file is added to %s runtime directory while watching', async (_, state) => {
    const dir = await copyExample(`.temp-tsdown-watch-added-${state}`, `export default {\n  plugins: [builder()],\n}\n`)
    if (state === 'missing') {
      await rm(join(dir, 'src/runtime'), { recursive: true, force: true })
      await writeFile(join(dir, 'src/module.ts'), `import { defineNuxtModule } from '@nuxt/kit'\n\nexport default defineNuxtModule({ meta: { name: 'my-module' } })\n`)
    }
    const watcher = watch(dir, [tsdownBin, '--watch'])
    try {
      await waitFor(async () => existsSync(join(dir, 'dist/module.json')))
      await mkdir(join(dir, 'src/runtime/utils/nested'), { recursive: true })
      await writeFile(join(dir, 'src/runtime/utils/nested/added.ts'), `export const added: string = 'added'\n`)
      await waitFor(async () => existsSync(join(dir, 'dist/runtime/utils/nested/added.js')) && existsSync(join(dir, 'dist/runtime/utils/nested/added.d.ts')))
    }
    finally {
      await watcher.stop()
    }
  }, 120 * 1000)

  it('should write current metadata from each build session in the same process', async () => {
    const dir = await copyExample('.temp-tsdown-meta-sessions', '')
    await rm(join(dir, 'tsdown.config.ts'))
    await writeFile(join(dir, 'sessions.mjs'), [
      `import { readFile, writeFile } from 'node:fs/promises'`,
      `import { build } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'node_modules/tsdown/dist/index.mjs')).href)}`,
      builderImport,
      `const cwd = ${JSON.stringify(dir)}`,
      `const source = await readFile(cwd + '/src/module.ts', 'utf8')`,
      `const names = []`,
      `for (const name of ['first-session', 'second-session']) {`,
      `  await writeFile(cwd + '/src/module.ts', source.replace("name: 'my-module'", 'name: ' + JSON.stringify(name)))`,
      `  await build({ cwd, config: false, logLevel: 'silent', plugins: [builder()] })`,
      `  names.push(JSON.parse(await readFile(cwd + '/dist/module.json', 'utf8')).name)`,
      `}`,
      `console.log(JSON.stringify(names))`,
      '',
    ].join('\n'))
    const { stdout, stderr, exitCode } = await exec('node', ['sessions.mjs'], { nodeOptions: { cwd: dir, env: { ...process.env, NODE_ENV: '', TEST: '' } } })
    expect(exitCode, stdout + stderr).toBe(0)
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual(['first-session', 'second-session'])
  }, 120 * 1000)

  it('should remove the output of a runtime file deleted while watching', async () => {
    const dir = await copyExample('.temp-tsdown-watch-deleted', `export default {\n  plugins: [builder()],\n}\n`)
    await writeFile(join(dir, 'src/runtime/removed.ts'), `export const removed: string = 'removed'\n`)
    const outputs = ['dist/runtime/removed.js', 'dist/runtime/removed.d.ts'].map(output => join(dir, output))
    const watcher = watch(dir, [tsdownBin, '--watch'])
    try {
      await waitFor(async () => existsSync(join(dir, 'dist/module.json')) && outputs.every(output => existsSync(output)))
      await rm(join(dir, 'src/runtime/removed.ts'))
      await waitFor(async () => outputs.every(output => !existsSync(output)))
      expect(existsSync(join(dir, 'dist/runtime/plugins/plugin.js'))).toBe(true)
    }
    finally {
      await watcher.stop()
    }
  }, 120 * 1000)

  it.each([
    ['the module entry', 'module', 'src/module.ts', 'types.d.mts'],
    ['a runtime file', 'runtime', 'src/runtime/plugins/plugin.ts', 'runtime/plugins/plugin.js'],
  ])('should keep the previous output when a watched rebuild of %s fails, and recover on the next good save', async (_, name, file, recovered) => {
    const dir = await copyExample(`.temp-tsdown-watch-failure-${name}`, `export default {\n  plugins: [builder()],\n}\n`)
    const files = ['module.mjs', 'module.d.mts', 'module.json', 'types.d.mts', 'runtime/plugins/plugin.js'].map(output => join(dir, 'dist', output))
    const source = await readFile(join(dir, file), 'utf-8')
    const watcher = watch(dir, [tsdownBin, '--watch'])
    try {
      await waitFor(async () => files.every(output => existsSync(output)))
      const before = await Promise.all(files.map(output => readFile(output, 'utf-8')))
      const seen = watcher.output().length
      await writeFile(join(dir, file), `${source}\nexport const broken = (\n`)
      await waitFor(async () => /error/i.test(watcher.output().slice(seen)))
      await delay(1000)
      expect(await Promise.all(files.map(output => readFile(output, 'utf-8')))).toEqual(before)
      await writeFile(join(dir, file), `${source}\nexport const recoveredMarker: string = 'recovered'\n`)
      await waitFor(async () => (await readFile(join(dir, 'dist', recovered), 'utf-8')).includes('recoveredMarker'))
    }
    finally {
      await watcher.stop()
    }
  }, 120 * 1000)

  it('should rewrite `types.d.mts` and `module.json` when a watched build rebuilds', async () => {
    const dir = await copyExample('.temp-tsdown-watch', `export default {\n  plugins: [builder({ entries: ['./src/utils'] })],\n}\n`)
    const types = join(dir, 'dist/types.d.mts')
    const watcher = tsdown(dir, ['--watch'])
    try {
      await waitFor(async () => existsSync(types) && existsSync(join(dir, 'dist/module.json')))
      expect(await readFile(types, 'utf-8')).not.toContain('rebuiltMarker')
      await writeFile(join(dir, 'src/runtime/composables/added.d.ts'), `import type { NuxtApp } from '#app'\nexport type Added = NuxtApp\n`)
      const source = await readFile(join(dir, 'src/module.ts'), 'utf-8')
      await writeFile(join(dir, 'src/module.ts'), `${source.replace(`name: 'my-module'`, `name: 'my-rebuilt-module'`)}\nexport const rebuiltMarker: string = 'rebuilt'\n`)
      await waitFor(async () => existsSync(types) && (await readFile(types, 'utf-8')).includes('rebuiltMarker'))
      await waitFor(async () => JSON.parse(await readFile(join(dir, 'dist/module.json'), 'utf-8')).name === 'my-rebuilt-module')
      expect(await readFile(join(dir, 'dist/runtime/composables/added.d.ts'), 'utf-8')).toContain(`from 'nuxt/app'`)
    }
    finally {
      watcher.kill()
    }
  }, 120 * 1000)

  it('should break the size report down by entry and runtime directory only when it is a summary', async () => {
    const rows = (output: string) => [...output.matchAll(/(dist\/(?:module\.mjs|runtime\/))\s[^\n]*types/g)].map(match => match[1]).sort()
    const breakdown = ['dist/module.mjs', 'dist/runtime/']
    for (const [report, expected] of [[undefined, breakdown], ['{ summary: true }', breakdown], ['{ summary: false }', []], ['false', []]] as const) {
      const dir = await copyExample(`.temp-tsdown-report-${String(report).replace(/\W/g, '')}`, `export default {\n  ${report === undefined ? '' : `report: ${report},`}\n  plugins: [builder()],\n}\n`)
      const built = await tsdown(dir)
      expect(built.exitCode, String(report)).toBe(0)
      expect(rows(built.stdout + built.stderr), String(report)).toEqual(expected)
      if (report === undefined) {
        const stubbed = await exec('pnpm', ['nuxt-module-build', 'build', '--stub', dir], { nodeOptions: { cwd: repoRoot } })
        expect(stubbed.exitCode).toBe(0)
        expect(rows(stubbed.stdout + stubbed.stderr)).toEqual([])

        const watcher = watch(dir, [tsdownBin, '--watch'])
        const types = join(dir, 'dist/types.d.mts')
        try {
          await waitFor(async () => rows(watcher.output()).length >= 2 && existsSync(types))
          await delay(1000)
          expect(rows(watcher.output())).toEqual(breakdown)
          const seen = watcher.output().length
          await appendFile(join(dir, 'src/module.ts'), '\nexport const reportRebuild: string = "rebuilt"\n')
          await waitFor(async () => rows(watcher.output().slice(seen)).length >= 2 && (await readFile(types, 'utf-8')).includes('reportRebuild'))
          await delay(1000)
          expect(rows(watcher.output().slice(seen))).toEqual(breakdown)
        }
        finally {
          await watcher.stop()
        }
      }
    }
  }, 180 * 1000)

  it('should be published at `@nuxt/module-builder/tsdown`, not at the package root', async () => {
    const built = await exec('node', [tsdownBin], { nodeOptions: { cwd: repoRoot } })
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    const loaded = await exec('node', ['--input-type=module', '-e', `const root = await import('@nuxt/module-builder')\nconst { builder } = await import('@nuxt/module-builder/tsdown')\nconsole.log(JSON.stringify(['builder' in root, builder().name]))`], { nodeOptions: { cwd: repoRoot } })
    expect(JSON.parse(loaded.stdout)).toEqual([false, 'nuxt-module-builder'])
  }, 120 * 1000)

  it('should prepare a module without `.nuxt` before building it', async () => {
    const dir = await copyExample('.temp-tsdown-auto-prepare', `export default {\n  plugins: [builder()],\n}\n`)
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const { exitCode, stdout, stderr } = await exec('node', [tsdownBin], { nodeOptions: { cwd: dir, env: { ...process.env, NODE_ENV: '', TEST: '', NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(exitCode).toBe(0)
    expect(stdout + stderr).toContain(guide('preparing-nuxt'))
    expect(existsSync(join(dir, '.nuxt/tsconfig.json'))).toBe(true)
    expect(await readFile(join(dir, 'dist/runtime/composables/useAliasedApp.d.ts'), 'utf-8')).toMatch(/import\("nuxt\/app"\)\.NuxtApp/)
  }, 120 * 1000)

  it('should reject one plugin instance shared by two configs', async () => {
    const dir = await copyExample('.temp-tsdown-shared', `const plugin = builder()\n\nexport default [\n  { plugins: [plugin] },\n  { plugins: [plugin], outDir: 'dist-other' },\n]\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toContain('The same `builder()` plugin is used in more than one tsdown config.')
  }, 60 * 1000)

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
  }, 60 * 1000)

  describe('with `package.json` pointing at the sources and `publishConfig` at `dist`', () => {
    let dir: string

    beforeAll(async () => {
      dir = await copyExample('.temp-tsdown-source-exports', `export default {\n  publint: true,\n  plugins: [builder({ entries: ['./src/utils'] })],\n}\n`)
      const pkgPath = join(dir, 'package.json')
      const { typesVersions: _, ...pkg } = JSON.parse(await readFile(pkgPath, 'utf-8'))
      await writeFile(pkgPath, JSON.stringify({
        ...pkg,
        exports: { '.': { types: './src/module.ts', default: './src/module.ts' }, './utils': './src/utils.ts' },
        main: './src/module.ts',
        types: './src/module.ts',
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
    }, 60 * 1000)

    it('should let the playground load the module from its sources, without `dist`', async () => {
      await rm(join(dir, 'playground/.nuxt'), { recursive: true, force: true })
      const { exitCode, stdout, stderr } = await exec('node', [join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'prepare', 'playground'], { nodeOptions: { cwd: dir, env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
      expect(exitCode, stdout + stderr).toBe(0)
      expect(existsSync(join(dir, 'dist'))).toBe(false)
      expect(await readFile(join(dir, 'playground/.nuxt/types/plugins.d.ts'), 'utf-8')).toContain('src/runtime/plugins/plugin')
    }, 120 * 1000)

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
    }, 120 * 1000)

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
    }, 120 * 1000)
  })

  describe('with `nuxt-module-build`', () => {
    const cli = (args: string[]) => exec('pnpm', ['nuxt-module-build', ...args], { nodeOptions: { cwd: repoRoot, env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    const options = (outDir: string) => `{ entries: [{ input: './src/utils', name: 'helpers' }, { input: 'src/shared/', outDir: '${outDir}/shared' }] }`
    const exportShapes = {
      object: `export default {\n  plugins: [builder(${options('dist')})],\n}\n`,
      array: `export default [\n  { entry: { cli: 'src/cli.ts' }, outDir: 'dist-cli', dts: false },\n  { plugins: [builder(${options('out')})], outDir: 'out' },\n]\n`,
      function: `export default () => ({\n  plugins: [Promise.resolve(builder(${options('dist')}))],\n})\n`,
    }
    const outDirs = { object: 'dist', array: 'out', function: 'dist' }

    const copyWithShape = async (shape: keyof typeof exportShapes) => {
      const dir = await copyExample(`.temp-tsdown-${shape}-export`, exportShapes[shape])
      await rm(join(dir, '.nuxt'), { recursive: true, force: true })
      await mkdir(join(dir, 'src/shared'), { recursive: true })
      await writeFile(join(dir, 'src/shared/value.ts'), `export { other } from './other.ts'\n`)
      await writeFile(join(dir, 'src/shared/other.ts'), `export const other: string = 'other'\n`)
      await writeFile(join(dir, 'src/cli.ts'), `export const cli: string = 'cli'\n`)
      await appendFile(join(dir, 'src/module.ts'), `export { other } from './shared/value.ts'\n`)
      return dir
    }

    it.each(Object.keys(exportShapes) as Array<keyof typeof exportShapes>)('should stub, prepare and build a module whose tsdown config exports %s', async (shape) => {
      const dir = await copyWithShape(shape)
      const outDir = join(dir, outDirs[shape])

      const stubbed = await cli(['build', '--stub', dir])
      expect(stubbed.stdout + stubbed.stderr).not.toContain('ERROR')
      expect(stubbed.exitCode).toBe(0)
      expect(await readFile(join(outDir, 'helpers.mjs'), 'utf-8')).toContain(`from '../src/utils.ts'`)
      expect(JSON.parse(await readFile(join(outDir, 'module.json'), 'utf-8'))).toMatchObject({ name: 'my-module' })

      const prepared = await cli(['prepare', dir])
      expect(prepared.exitCode).toBe(0)
      expect(existsSync(join(dir, '.nuxt/tsconfig.json'))).toBe(true)

      const built = await cli(['build', dir])
      expect(built.exitCode).toBe(0)
      expect(await readFile(join(outDir, 'shared/value.mjs'), 'utf-8')).toContain(`from "./other.mjs"`)
      expect(existsSync(join(outDir, 'helpers.mjs'))).toBe(true)
      expect(existsSync(join(outDir, 'types.d.mts'))).toBe(true)
      if (shape === 'array') {
        expect(await readFile(join(dir, 'dist-cli/cli.mjs'), 'utf-8')).toContain(`const cli = "cli"`)
      }
    }, 180 * 1000)

    it('should build with the tsdown config\'s `outDir` and `sourcemap` unless `--outDir` and `--sourcemap` override them', async () => {
      const dir = await copyExample('.temp-tsdown-build-flags', `export default {\n  outDir: 'out',\n  sourcemap: true,\n  plugins: [builder()],\n}\n`)
      expect((await cli(['build', dir])).exitCode).toBe(0)
      expect(existsSync(join(dir, 'out/module.mjs.map'))).toBe(true)
      expect(existsSync(join(dir, 'out/runtime/plugins/plugin.js.map'))).toBe(true)
      expect(existsSync(join(dir, 'dist'))).toBe(false)

      expect((await cli(['build', '--outDir', 'custom', '--no-sourcemap', dir])).exitCode).toBe(0)
      expect(existsSync(join(dir, 'custom/module.json'))).toBe(true)
      expect(existsSync(join(dir, 'custom/module.mjs.map'))).toBe(false)
      expect(existsSync(join(dir, 'custom/runtime/plugins/plugin.js.map'))).toBe(false)
    }, 120 * 1000)

    it('should refuse `hooks` in `builder()` and point at tsdown\'s own', async () => {
      const dir = await copyExample('.temp-tsdown-builder-hooks', `export default {\n  plugins: [builder({ hooks: { 'build:before': () => {} } })],\n}\n`)
      for (const args of [['build'], ['build', '--stub']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain(`\`builder()\` does not take \`hooks\`. Use tsdown's own \`hooks\` in the tsdown config, or a plugin that emits extra files. ${guide('hooks-in-a-tsdown-config')}`)
      }
    }, 60 * 1000)

    it('should load the package root and stub a module without tsdown', async () => {
      const dir = await copyExample('.temp-tsdown-without-tsdown', `export default {\n  plugins: [builder({ entries: [{ input: './src/utils', name: 'helpers' }] })],\n}\n`)
      const hook = join(dir, 'no-tsdown.mjs')
      await writeFile(hook, `import { registerHooks } from 'node:module'\n\nregisterHooks({\n  resolve(specifier, context, nextResolve) {\n    if (/^(?:tsdown|rolldown)(?:\\/|$)/.test(specifier)) {\n      throw Object.assign(new Error(\`Cannot find package '\${specifier}'\`), { code: 'ERR_MODULE_NOT_FOUND' })\n    }\n    return nextResolve(specifier, context)\n  },\n})\n`)
      const node = (args: string[]) => exec('node', ['--import', pathToFileURL(hook).href, ...args], { nodeOptions: { cwd: dir } })

      const root = await node(['--input-type=module', '-e', `await import('tsdown').then(() => console.log('tsdown found'), () => {})\nconst root = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'src/index.ts')).href)})\nconsole.log(Object.keys(root).sort().join(','))`])
      expect(root.stdout.trim()).toBe('build,defineBuildConfig,prepare')

      const stubbed = await node([join(repoRoot, 'src/cli.ts'), 'build', '--stub', dir])
      expect(stubbed.exitCode, stubbed.stdout + stubbed.stderr).toBe(0)
      expect(existsSync(join(dir, 'dist/helpers.mjs'))).toBe(true)

      const built = await node([join(repoRoot, 'src/cli.ts'), 'build', dir])
      expect(built.exitCode).not.toBe(0)
      expect(built.stdout + built.stderr).toContain(guide('install-tsdown'))
    }, 60 * 1000)

    it.each([['without a tsdown config', ''], ['with a tsdown config', `export default {\n  outDir: 'out',\n  plugins: [builder()],\n}\n`]])('should stub the module and then prepare `.nuxt` with `prepare --stub`, %s', async (_, config) => {
      const dir = await copyExample(`.temp-tsdown-prepare-stub-${config ? 'config' : 'zero'}`, config)
      if (!config) {
        await rm(join(dir, 'tsdown.config.ts'))
      }
      await rm(join(dir, '.nuxt'), { recursive: true, force: true })
      const { exitCode, stdout, stderr } = await cli(['prepare', '--stub', dir])
      expect(exitCode, stdout + stderr).toBe(0)
      expect(await readFile(join(dir, config ? 'out' : 'dist', 'module.mjs'), 'utf-8')).toContain(`from '../src/module.ts'`)
      expect(existsSync(join(dir, '.nuxt/tsconfig.json'))).toBe(true)
    }, 120 * 1000)

    it('should stub into `--outDir` over the tsdown config\'s `outDir`', async () => {
      const dir = await copyExample('.temp-tsdown-stub-out-dir', `export default {\n  outDir: 'out',\n  plugins: [builder()],\n}\n`)
      expect((await cli(['build', '--stub', '--outDir', '.stub', dir])).exitCode).toBe(0)
      expect(existsSync(join(dir, '.stub/module.mjs'))).toBe(true)
      expect(existsSync(join(dir, 'out'))).toBe(false)
    }, 60 * 1000)

    it('should fail to stub or prepare with a tsdown config whose `cwd` is another directory', async () => {
      const dir = await copyExample('.temp-tsdown-config-cwd', `export default {\n  cwd: './elsewhere',\n  plugins: [builder()],\n}\n`)
      for (const args of [['build', '--stub'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain('`tsdown.config.ts` sets `cwd`, but `build --stub` and `prepare` read the module in the directory of the tsdown config.')
      }
      await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\nexport default {\n  cwd: '.',\n  plugins: [builder()],\n}\n`)
      expect((await cli(['build', '--stub', dir])).exitCode).toBe(0)
    }, 120 * 1000)

    it('should fail on a tsdown config that Node cannot load', async () => {
      const dir = await copyExample('.temp-tsdown-config-enum', `enum Mode { Build }\nexport default {\n  define: { __MODE__: String(Mode.Build) },\n  plugins: [builder()],\n}\n`)
      for (const args of [['build'], ['build', '--stub'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain('tsdown.config.ts:2:1: `enum` (use an `as const` object and a union type of its values)')
        expect(stdout + stderr, args.join(' ')).toContain(guide('module-code-loads-with-node'))
      }
    }, 120 * 1000)

    it('should fail on a tsdown config without `builder()` and show how to add it', async () => {
      const dir = await copyExample('.temp-tsdown-without-plugin', `export default {}\n`)
      for (const args of [['build'], ['build', '--stub'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain([
          '`tsdown.config.ts` does not build the module with `builder()`. Add the plugin:',
          '',
          `  import { builder } from '@nuxt/module-builder/tsdown'`,
          `  import { defineConfig } from 'tsdown'`,
          '',
          `  export default defineConfig({`,
          `    plugins: [builder()],`,
          `  })`,
        ].join('\n'))
        expect(stdout + stderr, args.join(' ')).toContain(guide('tsdown-config'))
      }
    }, 120 * 1000)

    it('should fail when no config of the tsdown config uses `builder()`', async () => {
      const dir = await copyExample('.temp-tsdown-entries-only', `export default [{ entry: { utils: 'src/utils.ts' }, dts: false }]\n`)
      const { exitCode, stdout, stderr } = await cli(['build', dir])
      expect(exitCode).not.toBe(0)
      expect(stdout + stderr).toContain('`tsdown.config.ts` does not build the module with `builder()`.')
      expect(existsSync(join(dir, 'dist'))).toBe(false)
    }, 60 * 1000)

    it('should fail when `package.json` configures the build too', async () => {
      const dir = await copyExample('.temp-tsdown-legacy-field', `export default {\n  plugins: [builder()],\n}\n`)
      const pkgPath = join(dir, 'package.json')
      await writeFile(pkgPath, JSON.stringify({ ...JSON.parse(await readFile(pkgPath, 'utf-8')), build: { entries: ['./src/utils'] } }))
      for (const args of [['build'], ['build', '--stub'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain('The `build` field of `package.json` configures the build, and so does `builder()` in the tsdown config.')
      }
    }, 120 * 1000)
  })

  it('should fail when `build.config.ts` configures the build too', async () => {
    const dir = await copyExample('.temp-tsdown-legacy', `export default {\n  plugins: [builder()],\n}\n`)
    await writeFile(join(dir, 'build.config.ts'), `export default {}\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toContain(`\`build.config.ts\` configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and delete the file. ${guide('moving-from-buildconfigts')}`)
  }, 60 * 1000)
})
