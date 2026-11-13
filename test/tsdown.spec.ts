import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    await appendFile(join(hooksDir, 'src/module.ts'), [
      `import { generated } from './generated.ts'`,
      `import { ext } from 'fake-ext'`,
      `import { useWrappedFetch } from './runtime/composables/useWrappedFetch.ts'`,
      `export const refs: unknown[] = [generated, ext, useWrappedFetch, '__USER__']`,
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
    expect(module).toContain('from "./runtime/composables/useWrappedFetch.js"')
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

  it('should fail when `build.config.ts` configures the build too', async () => {
    const dir = await copyExample('.temp-tsdown-legacy', `export default {\n  plugins: [builder()],\n}\n`)
    await writeFile(join(dir, 'build.config.ts'), `export default {}\n`)
    const { exitCode, stdout, stderr } = await tsdown(dir)
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toContain(`\`build.config.ts\` configures the build, and so does \`builder()\` in the tsdown config. Move its options into \`builder()\` and delete the file. ${guide('moving-from-buildconfigts')}`)
  }, 60 * 1000)
})
