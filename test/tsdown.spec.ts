import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative } from 'pathe'
import { exec } from 'tinyexec'
import ts from 'typescript'
import { beforeAll, describe, expect, it, onTestFailed } from 'vitest'

import { guide } from '../src/build/guide.ts'
import { publishedPackage } from '../src/build/package.ts'
import { npmPackFromPnpmScript, packProbeArgs, packProbeContext } from './pack-env.ts'

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
  const { build: _, publishConfig: __, ...pkg } = publishedPackage(JSON.parse(await readFile(pkgPath, 'utf-8')))
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\n${config}`)
  return dir
}

const tsdown = (cwd: string, args: string[] = [], env: Record<string, string> = {}) => exec('node', [tsdownBin, ...args], { nodeOptions: { cwd, env: { ...process.env, NODE_ENV: '', TEST: '', ...env } } })

function watch(cwd: string, args: string[]) {
  const result = exec('node', args, { nodeOptions: { cwd, env: { ...process.env, NODE_ENV: '', TEST: '' } } })
  let output = ''
  onTestFailed(() => {
    console.error(`Output of \`node ${args.join(' ')}\`:\n${output.slice(-8000)}`)
  })
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
  })

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
  })

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
  })

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
  })

  it('should compile JSX in a server runtime file added while watching', async () => {
    const dir = await copyExample('.temp-tsdown-watch-jsx', `export default {\n  plugins: [builder()],\n}\n`)
    const watcher = watch(dir, [tsdownBin, '--watch'])
    try {
      await waitFor(async () => existsSync(join(dir, 'dist/module.json')))
      await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
      await writeFile(join(dir, 'src/runtime/server/render.tsx'), `export const render = (): unknown => <p>hi</p>\n`)
      await waitFor(async () => existsSync(join(dir, 'dist/runtime/server/render.js')) || existsSync(join(dir, 'dist/runtime/server/render.jsx')))
      expect(existsSync(join(dir, 'dist/runtime/server/render.jsx'))).toBe(false)
      expect(await readFile(join(dir, 'dist/runtime/server/render.js'), 'utf-8')).toContain('vue/jsx-runtime')
    }
    finally {
      await watcher.stop()
    }
  })

  it('should rebuild when a file outside the runtime directory that a runtime file imports changes while watching', async () => {
    const dir = await copyExample('.temp-tsdown-watch-outside', `export default {\n  plugins: [builder()],\n}\n`)
    await writeFile(join(dir, 'src/shared.ts'), `export const shared: string = 'first'\n`)
    await writeFile(join(dir, 'src/runtime/use.ts'), `import { shared } from '../shared'\n\nexport const useShared = (): string => shared\n`)
    const output = join(dir, 'dist/shared.js')
    const watcher = watch(dir, [tsdownBin, '--watch'])
    try {
      await waitFor(async () => existsSync(output) && (await readFile(output, 'utf-8')).includes('first'))
      await writeFile(join(dir, 'src/shared.ts'), `export const shared: string = 'second'\n`)
      await waitFor(async () => (await readFile(output, 'utf-8')).includes('second'))
    }
    finally {
      await watcher.stop()
    }
  })

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
  })

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
  })

  it('should keep `dist` while a watched build starts, and empty it before a one-off build', async () => {
    const dir = await copyExample('.temp-tsdown-watch-kept', `export default {\n  plugins: [builder()],\n}\n`)
    const distDir = join(dir, 'dist')
    const stale = ['stale.txt', 'runtime/components/Removed.vue']
    const addStale = () => Promise.all(stale.map(file => writeFile(join(distDir, file), 'stale\n')))
    const snapshot = async () => {
      const files = (await readdir(distDir, { recursive: true, withFileTypes: true })).filter(file => file.isFile())
      return new Map(await Promise.all(files.map(async (file) => {
        const path = join(file.parentPath, file.name)
        return [relative(distDir, path), (await stat(path, { bigint: true })).mtimeNs] as const
      })))
    }

    expect((await tsdown(dir)).exitCode).toBe(0)
    await addStale()
    expect((await tsdown(dir)).exitCode).toBe(0)
    expect(stale.filter(file => existsSync(join(distDir, file)))).toEqual([])

    await addStale()
    const before = await snapshot()
    const watcher = watch(dir, [tsdownBin, '--watch'])
    let missing = false
    try {
      await waitFor(async () => {
        missing ||= !existsSync(join(distDir, 'module.mjs')) || !existsSync(join(distDir, 'runtime/plugins/plugin.js'))
        return /Rebuilt in/.test(watcher.output())
      })
      const after = await snapshot()
      expect(missing).toBe(false)
      expect([...before.keys()].filter(file => !after.has(file)).sort()).toEqual([...stale].sort())
      expect([...after.keys()].filter(file => before.get(file) !== after.get(file) && !file.endsWith('.d.ts'))).toEqual([])
    }
    finally {
      await watcher.stop()
    }
  })

  it('should only write the outputs whose content changes when a watched build rebuilds', async () => {
    const dir = await copyExample('.temp-tsdown-watch-unchanged', `export default {\n  plugins: [\n    builder({ entries: ['./src/utils'] }),\n    { name: 'user-asset', generateBundle() { this.emitFile({ type: 'asset', fileName: 'user.txt', source: 'user asset\\n' }) } },\n  ],\n}\n`)
    const distDir = join(dir, 'dist')
    const snapshot = async () => {
      const files = (await readdir(distDir, { recursive: true, withFileTypes: true })).filter(file => file.isFile())
      return new Map(await Promise.all(files.map(async (file) => {
        const path = join(file.parentPath, file.name)
        return [relative(distDir, path), { mtime: (await stat(path, { bigint: true })).mtimeNs, hash: createHash('sha256').update(await readFile(path)).digest('hex') }] as const
      })))
    }
    const changes = (before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) => ({
      changed: [...after.keys()].filter(file => before.has(file) && before.get(file)!.mtime !== after.get(file)!.mtime).sort(),
      added: [...after.keys()].filter(file => !before.has(file)).sort(),
      removed: [...before.keys()].filter(file => !after.has(file)).sort(),
    })
    const watcher = watch(dir, [tsdownBin, '--watch'])
    const rebuilds = () => watcher.output().match(/Rebuilt in/g)?.length ?? 0
    const rebuild = async (change: () => Promise<void>) => {
      const before = await snapshot()
      const count = rebuilds()
      await change()
      await waitFor(async () => rebuilds() > count)
      return changes(before, await snapshot())
    }
    const edit = async (file: string, from: string, to: string) => writeFile(join(dir, file), (await readFile(join(dir, file), 'utf-8')).replace(from, to))
    try {
      await waitFor(async () => rebuilds() > 0 && existsSync(join(distDir, 'module.json')) && existsSync(join(distDir, 'types.d.mts')))
      expect(await readFile(join(distDir, 'user.txt'), 'utf-8')).toBe('user asset\n')

      await rm(join(distDir, 'runtime/plugins/plugin.js'))
      expect(await rebuild(() => edit('src/runtime/components/TestMe.vue', '', ''))).toEqual({ changed: [], added: ['runtime/plugins/plugin.js'], removed: [] })

      expect(await rebuild(() => edit('src/runtime/components/TestMe.vue', '{{ count }}', 'count: {{ count }}'))).toEqual({ changed: ['runtime/components/TestMe.vue'], added: [], removed: [] })
      expect(await rebuild(() => edit('src/runtime/components/TestMe.vue', '', ''))).toEqual({ changed: [], added: [], removed: [] })
      expect(await rebuild(() => edit('src/module.ts', `name: 'my-module'`, `name: 'my-renamed-module'`))).toEqual({ changed: ['module.json', 'module.mjs'], added: [], removed: [] })
      expect(await rebuild(() => rm(join(dir, 'src/runtime/composables/useAppNuxt.ts')))).toEqual({ changed: [], added: [], removed: ['runtime/composables/useAppNuxt.d.ts', 'runtime/composables/useAppNuxt.js'] })

      const before = await snapshot()
      const plugin = await readFile(join(dir, 'src/runtime/plugins/plugin.ts'), 'utf-8')
      const failures = () => watcher.output().match(/Failed to transpile/g)?.length ?? 0
      const failed = failures()
      await writeFile(join(dir, 'src/runtime/plugins/plugin.ts'), `${plugin}\nexport const broken: = 1\n`)
      await waitFor(async () => failures() > failed)
      expect(changes(before, await snapshot())).toEqual({ changed: [], added: [], removed: [] })
      expect(await rebuild(() => writeFile(join(dir, 'src/runtime/plugins/plugin.ts'), plugin))).toEqual({ changed: [], added: [], removed: [] })
      expect([...(await snapshot()).entries()].map(([file, { hash }]) => [file, hash])).toEqual([...before.entries()].map(([file, { hash }]) => [file, hash]))
    }
    finally {
      await watcher.stop()
    }
  })

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
  })

  it('should break the size report down by entry and runtime directory only when it is a summary', async () => {
    const rows = (output: string) => [...output.matchAll(/(dist\/(?:module\.mjs|runtime\/))\s[^\n]*types/g)].map(match => match[1]).sort()
    const breakdown = ['dist/module.mjs', 'dist/runtime/']
    for (const [report, expected] of [[undefined, breakdown], ['{ summary: true }', breakdown], ['{ summary: false }', []], ['false', []]] as const) {
      const dir = await copyExample(`.temp-tsdown-report-${String(report).replace(/\W/g, '')}`, `export default {\n  ${report === undefined ? '' : `report: ${report},`}\n  plugins: [builder()],\n}\n`)
      const built = await tsdown(dir)
      expect(built.exitCode, String(report)).toBe(0)
      expect(rows(built.stdout + built.stderr), String(report)).toEqual(expected)
      if (report === undefined) {
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

  describe('with `nuxt-module-build`', () => {
    const cli = (args: string[]) => exec('pnpm', ['nuxt-module-build', ...args], { nodeOptions: { cwd: repoRoot, env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    const options = (outDir: string) => `{ entries: [{ input: './src/utils', name: 'helpers' }, { input: 'src/shared/', outDir: '${outDir}/shared' }] }`
    const exportShapes = {
      object: `export default {\n  plugins: [builder(${options('dist')})],\n}\n`,
      array: `export default [\n  { entry: { cli: 'src/cli.ts' }, outDir: 'dist-cli', dts: false },\n  { plugins: [builder(${options('out')})], outDir: 'out' },\n]\n`,
      function: `export default (_, { watch: { restart } }) => ({\n  plugins: [Promise.resolve(builder(${options('dist')}))],\n})\n`,
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

    it.each(Object.keys(exportShapes) as Array<keyof typeof exportShapes>)('should prepare and build a module whose tsdown config exports %s', async (shape) => {
      const dir = await copyWithShape(shape)
      const outDir = join(dir, outDirs[shape])

      const prepared = await cli(['prepare', dir])
      expect(prepared.stdout + prepared.stderr).not.toContain('ERROR')
      expect(prepared.exitCode).toBe(0)
      expect(existsSync(join(dir, '.nuxt/tsconfig.json'))).toBe(true)
      expect(existsSync(join(dir, '.nuxt/module-builder/types.d.mts'))).toBe(true)

      const built = await cli(['build', dir])
      expect(built.exitCode).toBe(0)
      expect(await readFile(join(outDir, 'shared/value.mjs'), 'utf-8')).toContain(`from "./other.mjs"`)
      expect(existsSync(join(outDir, 'helpers.mjs'))).toBe(true)
      expect(existsSync(join(outDir, 'types.d.mts'))).toBe(true)
      expect(JSON.parse(await readFile(join(outDir, 'module.json'), 'utf-8'))).toMatchObject({ name: 'my-module' })
      if (shape === 'array') {
        expect(await readFile(join(dir, 'dist-cli/cli.mjs'), 'utf-8')).toContain(`const cli = "cli"`)
      }
    })

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
    })

    it('should refuse `hooks` in `builder()` and point at tsdown\'s own', async () => {
      const dir = await copyExample('.temp-tsdown-builder-hooks', `export default {\n  plugins: [builder({ hooks: { 'build:before': () => {} } })],\n}\n`)
      for (const args of [['build'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain(`\`builder()\` does not take \`hooks\`. Use tsdown's own \`hooks\` in the tsdown config, or a plugin that emits extra files. ${guide('hooks-in-a-tsdown-config')}`)
      }
    })

    it('should load the package root without tsdown, and point at installing it to build', async () => {
      const dir = await copyExample('.temp-tsdown-without-tsdown', `export default {\n  plugins: [builder({ entries: [{ input: './src/utils', name: 'helpers' }] })],\n}\n`)
      const hook = join(dir, 'no-tsdown.mjs')
      await writeFile(hook, `import { registerHooks } from 'node:module'\n\nregisterHooks({\n  resolve(specifier, context, nextResolve) {\n    if (/^(?:tsdown|rolldown)(?:\\/|$)/.test(specifier)) {\n      throw Object.assign(new Error(\`Cannot find package '\${specifier}'\`), { code: 'ERR_MODULE_NOT_FOUND' })\n    }\n    return nextResolve(specifier, context)\n  },\n})\n`)
      const node = (args: string[]) => exec('node', ['--import', pathToFileURL(hook).href, ...args], { nodeOptions: { cwd: dir } })

      const root = await node(['--input-type=module', '-e', `await import('tsdown').then(() => console.log('tsdown found'), () => {})\nconst root = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'src/index.ts')).href)})\nconsole.log(Object.keys(root).sort().join(','))`])
      expect(root.stdout.trim()).toBe('build,defineBuildConfig,prepare')

      const built = await node([join(repoRoot, 'src/cli.ts'), 'build', dir])
      expect(built.exitCode).not.toBe(0)
      expect(built.stdout + built.stderr).toContain(guide('install-tsdown'))
    })

    it('should fail on `--stub` and point at what replaces it', async () => {
      const dir = await copyExample('.temp-tsdown-stub-flag', `export default {\n  plugins: [builder()],\n}\n`)
      for (const command of ['build', 'prepare']) {
        const { exitCode, stdout, stderr } = await cli([command, '--stub', dir])
        expect(exitCode, command).not.toBe(0)
        expect(stdout + stderr, command).toContain(`\`nuxt-module-build ${command} --stub\` has been removed. With pnpm or Yarn 4, point \`package.json\` at the module's sources. Otherwise, build \`dist\` with \`tsdown\` and rebuild it with \`tsdown --watch\`. ${guide('stub-builds')}`)
      }
      expect(existsSync(join(dir, 'dist'))).toBe(false)
    })

    it('should fail to prepare with a tsdown config whose `cwd` is another directory', async () => {
      const dir = await copyExample('.temp-tsdown-config-cwd', `export default {\n  cwd: './elsewhere',\n  plugins: [builder()],\n}\n`)
      const { exitCode, stdout, stderr } = await cli(['prepare', dir])
      expect(exitCode).not.toBe(0)
      expect(stdout + stderr).toContain('`tsdown.config.ts` sets `cwd`, but `prepare` reads the module in the directory of the tsdown config.')
      await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\nexport default {\n  cwd: '.',\n  plugins: [builder()],\n}\n`)
      expect((await cli(['prepare', dir])).exitCode).toBe(0)
    })

    it('should fail on a tsdown config that Node cannot load', async () => {
      const dir = await copyExample('.temp-tsdown-config-enum', `enum Mode { Build }\nexport default {\n  define: { __MODE__: String(Mode.Build) },\n  plugins: [builder()],\n}\n`)
      for (const args of [['build'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain('tsdown.config.ts:2:1: `enum` (use an `as const` object and a union type of its values)')
        expect(stdout + stderr, args.join(' ')).toContain(guide('module-code-loads-with-node'))
      }
    })

    it('should fail on a tsdown config without `builder()` and show how to add it', async () => {
      const dir = await copyExample('.temp-tsdown-without-plugin', `export default {}\n`)
      for (const args of [['build'], ['prepare']]) {
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
    })

    it('should fail when no config of the tsdown config uses `builder()`', async () => {
      const dir = await copyExample('.temp-tsdown-entries-only', `export default [{ entry: { utils: 'src/utils.ts' }, dts: false }]\n`)
      const { exitCode, stdout, stderr } = await cli(['build', dir])
      expect(exitCode).not.toBe(0)
      expect(stdout + stderr).toContain('`tsdown.config.ts` does not build the module with `builder()`.')
      expect(existsSync(join(dir, 'dist'))).toBe(false)
    })

    it('should fail when `package.json` configures the build too', async () => {
      const dir = await copyExample('.temp-tsdown-legacy-field', `export default {\n  plugins: [builder()],\n}\n`)
      const pkgPath = join(dir, 'package.json')
      await writeFile(pkgPath, JSON.stringify({ ...JSON.parse(await readFile(pkgPath, 'utf-8')), build: { entries: ['./src/utils'] } }))
      for (const args of [['build'], ['prepare']]) {
        const { exitCode, stdout, stderr } = await cli([...args, dir])
        expect(exitCode, args.join(' ')).not.toBe(0)
        expect(stdout + stderr, args.join(' ')).toContain('The `build` field of `package.json` configures the build, and so does `builder()` in the tsdown config.')
      }
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

describe('with a root tsconfig that only lists references', () => {
  const references = (node: string) => ({
    files: [],
    exclude: ['dist', 'node_modules', 'playground'],
    references: [node, './.nuxt/tsconfig.app.json', './.nuxt/tsconfig.server.json', './.nuxt/tsconfig.shared.json'].map(path => ({ path })),
  })

  it('should generate tsconfigs for the module entry, without the playground or the workspace, and with app aliases for module code', async () => {
    const dir = await copyExample('.temp-tsdown-references-prepare', 'export default { plugins: [builder()] }\n')
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.options.json', files: [], references: [{ path: './tsconfig.module.json' }] }))
    await writeFile(join(dir, 'tsconfig.options.json'), JSON.stringify({ compilerOptions: { types: ['vitest/importMeta'] }, exclude: ['dist', 'node_modules', 'playground'] }))
    await writeFile(join(dir, 'tsconfig.module.json'), JSON.stringify({ extends: './tsconfig.base.json' }))
    await writeFile(join(dir, 'tsconfig.base.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node' }))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    expect((await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })).exitCode).toBe(0)
    const generated = async (name: string) => JSON.parse(await readFile(join(dir, `.nuxt/tsconfig.${name}.json`), 'utf-8'))
    const [node, app] = [await generated('node'), await generated('app')]
    expect(node.include).toContain('../src/*.ts')
    expect(node.compilerOptions.paths['#app']).toBeDefined()
    expect(node.compilerOptions.types).toContain('vitest/importMeta')
    expect(node.compilerOptions.paths['#components']).toBeDefined()
    expect(app.exclude).toContain('../playground')
    expect(app.include).not.toContain('../../**/*')
    expect(app.include).toContain('../src/runtime')
    for (const name of ['app', 'node', 'server', 'shared']) {
      const { include, exclude } = await generated(name)
      expect([...include, ...exclude].filter((pattern: string) => pattern.startsWith('../src/dist')), name).toEqual([])
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('should type runtime components with their own context and pass the type check', async () => {
    const dir = await copyExample('.temp-tsdown-references-contexts', 'export default { plugins: [builder()] }\n')
    const moduleSrc = join(dir, 'src/module.ts')
    await writeFile(moduleSrc, (await readFile(moduleSrc, 'utf-8'))
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addImports, addTemplate, addTypeTemplate, createResolver } from \'@nuxt/kit\'\nimport { moduleHelper } from \'./helpers/name.ts\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    _nuxt.options.alias[\'#my-types\'] = resolver.resolve(\'./runtime/types\')\n    addImports({ name: \'useThing\', from: resolver.resolve(\'./runtime/composables/useThing\') })\n    addTypeTemplate({ filename: \'module/my-module-names.d.ts\', getContents: () => \'declare module "#my-module/names" {\\n  export const names: string[]\\n}\\n\' }, { nuxt: false })\n    _nuxt.hook(\'prepare:types\', ({ tsConfig }) => { tsConfig.include?.push(\'./module/my-module-names.d.ts\') })\n    addTemplate({ filename: \'my-module-virtual.mjs\', getContents: () => \'export default 1\\n\' })\n    moduleHelper()'))
    await mkdir(join(dir, 'src/helpers'), { recursive: true })
    await mkdir(join(dir, 'src/runtime/types'), { recursive: true })
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    await mkdir(join(dir, 'test/fixture'), { recursive: true })
    await mkdir(join(dir, 'types'), { recursive: true })
    await Promise.all([
      writeFile(join(dir, 'types/virtual.d.ts'), `declare module '#my-root-virtual' {\n  export const rootValue: string\n}\n`),
      writeFile(join(dir, 'content.d.ts'), `export * from './dist/content'\n`),
      writeFile(join(dir, 'src/helpers/name.ts'), `import { useNuxt } from '@nuxt/kit'\n\nexport type { Linked } from '../runtime/linked.ts'\nexport type Jsx = typeof import('../runtime/components/JsxComponent.tsx').default\nexport type Names = ReturnType<typeof import('../runtime/composables/useNames.ts').useNames>\n\nexport function moduleHelper(): unknown {\n  return import.meta.vitest ? undefined : useNuxt().options.myModule\n}\n\nexport const callInit = (): unknown => useNuxt().callHook('my-module:init', 'shared-type')\n`),
      writeFile(join(dir, 'src/runtime/composables/useVirtual.ts'), `import value from '#build/my-module-virtual'\n\nexport const useVirtual = (): unknown => value\n`),
      writeFile(join(dir, 'src/runtime/composables/useNames.ts'), `import { names } from '#my-module/names'\n\nexport const useNames = (): string[] => names\n`),
      writeFile(join(dir, 'src/runtime/linked.ts'), `import type { NuxtLink } from '#components'\n\nexport type Linked = typeof NuxtLink\n`),
      writeFile(join(dir, 'src/env.d.ts'), `declare const __MY_MODULE_FLAG__: boolean\n`),
      writeFile(join(dir, 'ambient.d.ts'), `declare module '#my-virtual' {\n  export const virtualValue: string\n}\n`),
      writeFile(join(dir, 'src/runtime/server/virtual.ts'), `import { virtualValue } from '#my-virtual'\nimport { rootValue } from '#my-root-virtual'\n\nexport const value: string = import.meta.vitest ? '' : virtualValue + rootValue\n`),
      writeFile(join(dir, 'src/augments.d.ts'), `declare module '#app' {\n  interface NuxtApp {\n    $thing: 'thing'\n  }\n}\n\nexport {}\n`),
      writeFile(join(dir, 'src/runtime/composables/useAppThing.ts'), `import { useNuxtApp } from '#app'\n\nexport const useAppThing = (): 'thing' | undefined => import.meta.vitest ? undefined : useNuxtApp().$thing\n`),
      writeFile(join(dir, 'src/runtime/types/index.ts'), `export type Trigger = 'onNuxtReady' | string[] | boolean\n`),
      writeFile(join(dir, 'src/runtime/composables/useThing.ts'), `export function useThing() {\n  return { loggedIn: __MY_MODULE_FLAG__, user: null as { name: string } | null }\n}\n`),
      writeFile(join(dir, 'src/runtime/components/Triggered.vue'), `<script setup lang="ts">\nimport type { Trigger } from '#my-types'\n\ndefineProps<{ trigger?: Trigger }>()\n</script>\n\n<template>\n  <div />\n</template>\n`),
      writeFile(join(dir, 'src/runtime/components/ThingState.vue'), `<script setup lang="ts">\nimport { useThing } from '#imports'\n\nconst { loggedIn, user } = useThing()\n</script>\n\n<template>\n  <slot v-bind="{ loggedIn, user }" />\n</template>\n`),
      writeFile(join(dir, 'test/fixture/nuxt.config.ts'), `export default defineNuxtConfig({})\n`),
      writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
        files: [],
        compilerOptions: { types: ['vitest/importMeta'] },
        exclude: ['dist', 'node_modules', 'playground'],
        references: ['./.nuxt/tsconfig.app.json', './.nuxt/tsconfig.server.json', './.nuxt/tsconfig.shared.json', './.nuxt/tsconfig.node.json'].map(path => ({ path })),
      })),
    ])
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(built.stdout + built.stderr).not.toContain('type error')
    expect(await readFile(join(dir, 'dist/runtime/components/ThingState.d.vue.ts'), 'utf-8')).toMatch(/loggedIn: boolean;\s+user: \{\s+name: string;\s+\} \| null;/)
    expect(await readFile(join(dir, 'dist/runtime/components/Triggered.vue'), 'utf-8')).toMatch(/type: \[\s*String,\s*Array,\s*Boolean\s*\]/)
    const generated = async (name: string) => JSON.parse(await readFile(join(dir, `.nuxt/tsconfig.${name}.json`), 'utf-8'))
    for (const name of ['app', 'node', 'server', 'shared']) {
      const config = await generated(name)
      expect(config.files, name).toEqual(expect.arrayContaining([join(dir, 'src/env.d.ts'), join(dir, 'ambient.d.ts'), join(dir, 'types/virtual.d.ts')]))
      expect(config.files, name).not.toContain(join(dir, 'src/augments.d.ts'))
      expect(config.compilerOptions.types, name).toContain('vitest/importMeta')
    }
    for (const name of ['nuxt', 'nuxt.node']) {
      expect(await readFile(join(dir, `.nuxt/${name}.d.ts`), 'utf-8'), name).toContain('/// <reference path="../src/augments.d.ts" />')
    }
    expect(await readFile(join(dir, '.nuxt/nuxt.shared.d.ts'), 'utf-8')).not.toContain('augments.d.ts')
    expect(await readFile(join(dir, '.nuxt/nuxt.node.d.ts'), 'utf-8')).toContain('/// <reference path="module-builder/types.d.mts" />')
    const buildTypes = (await readFile(join(dir, '.nuxt/types/build.d.ts'), 'utf-8')).split('\n')
    expect(buildTypes).toContain('declare module "#build/my-module-virtual";')
    expect(buildTypes).not.toContain('declare module "#build/my-module-virtual.mjs";')
    const app = await generated('app')
    expect(app.include).not.toContain('../**/*')
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-b', '--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout + typecheck.stderr).toBe('')
    await rm(dir, { recursive: true, force: true })
  }, 240 * 1000)

  it('should give tsdown the project that includes the module entry, unless the config sets `tsconfig`', async () => {
    const dir = await copyExample('.temp-tsdown-references', 'export default { plugins: [builder()] }\n')
    await writeFile(join(dir, 'tsconfig.module.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { erasableSyntaxOnly: true, useDefineForClassFields: false } }))
    await writeFile(join(dir, 'tsconfig.override.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { useDefineForClassFields: true } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./tsconfig.module.json')))
    await appendFile(join(dir, 'src/module.ts'), `\nclass Fields { value!: string }\nexport const ownsField: boolean = Object.hasOwn(new Fields(), 'value')\n`)
    const ownsField = async () => (await readFile(join(dir, 'dist/module.mjs'), 'utf-8')).includes('\tvalue;')
    const result = await tsdown(dir, [], { CI: '' })
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('tsconfig: tsconfig.module.json')
    expect(result.stdout).toMatch(/Set `?isolatedDeclarations: true`? in `?tsconfig\.module\.json`?/)
    expect(await ownsField()).toBe(false)
    const referencesDist = await readFile(join(dir, 'dist/module.d.mts'), 'utf-8')

    await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\nexport default { tsconfig: 'tsconfig.override.json', plugins: [builder()] }\n`)
    expect((await tsdown(dir)).stdout).toContain('tsconfig: tsconfig.override.json')
    expect(await ownsField()).toBe(true)

    await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\nexport default { plugins: [builder()] }\n`)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground'] }))
    const legacy = await tsdown(dir)
    expect(legacy.exitCode).toBe(0)
    expect(legacy.stdout).toContain('tsconfig: tsconfig.json')
    expect(await readFile(join(dir, 'dist/module.d.mts'), 'utf-8')).toBe(referencesDist)
    await rm(dir, { recursive: true, force: true })
  })

  it('should resolve the module\'s own package to declarations of module code in its app, server and shared tsconfigs', async () => {
    const dir = await copyExample('.temp-tsdown-references-own-package', 'export default { plugins: [builder()] }\n')
    const { exports, main, types, publishConfig } = JSON.parse(await readFile(join(exampleDir, 'package.json'), 'utf-8'))
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, exports, main, types, publishConfig, imports: { '#my-helpers': './src/helpers.ts' } }))
    await writeFile(join(dir, 'src/helpers.ts'), `export interface Helper {\n  name: string\n}\n`)
    await writeFile(join(dir, 'src/extra.d.ts'), `export interface Extra {\n  id: string\n}\n`)
    const moduleSrc = join(dir, 'src/module.ts')
    await writeFile(moduleSrc, (await readFile(moduleSrc, 'utf-8'))
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addTypeTemplate, createResolver } from \'@nuxt/kit\'\n\nexport type { Helper } from \'#my-helpers\'\nexport type { Extra } from \'./extra\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    addTypeTemplate({ filename: \'types/my-module.d.ts\', getContents: () => \'import type { ModuleOptions } from "my-module"\\ndeclare module "#app" {\\n  interface NuxtApp {\\n    $myModuleOptions: ModuleOptions\\n  }\\n}\\nexport {}\\n\' })\n    const configured: unknown = _nuxt.options.myModule\n    void configured'))
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    await mkdir(join(dir, 'shared'), { recursive: true })
    await writeFile(join(dir, 'shared/options.ts'), `import type { Extra, ModuleOptions } from 'my-module'\n\nexport const sharedApiKey = (options: ModuleOptions, extra: Extra): string => options.apiKey + extra.id\n// @ts-expect-error a string is not a number\nexport const extraId = (extra: Extra): number => extra.id\n`)
    await writeFile(join(dir, 'src/runtime/composables/useUtils.ts'), `import { myModuleUtils } from 'my-module/utils'\n\nexport const useUtils = (): () => void => myModuleUtils\n`)
    await writeFile(join(dir, 'src/runtime/server/options.ts'), `import type { ModuleOptions } from 'my-module'\n\nexport const apiKey = (options: ModuleOptions): string => options.apiKey\n`)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-b', '--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout + typecheck.stderr).toBe('')
    for (const name of ['app', 'server', 'shared']) {
      const listed = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-p', `.nuxt/tsconfig.${name}.json`, '--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })
      const files = listed.stdout.split('\n').map(file => file.trim())
      expect(files, name).not.toContain(join(dir, 'src/module.ts'))
      expect(files, name).not.toContain(join(dir, 'src/utils.ts'))
      expect(files, name).not.toContain(join(dir, 'src/helpers.ts'))
      expect(files, name).toContain(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))
    }
    const app = (await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-p', '.nuxt/tsconfig.app.json', '--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })).stdout
    expect(app).toContain(join(dir, '.nuxt/module-builder/declarations/src/utils.d.ts'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should write the declarations of module code with oxc when its tsconfig sets `isolatedDeclarations`', async () => {
    const dir = await copyExample('.temp-tsdown-references-own-package-isolated', 'export default { plugins: [builder()] }\n')
    await mkdir(join(dir, 'src/nested'), { recursive: true })
    await writeFile(join(dir, 'src/nested/payload.ts'), `export interface Payload {\n  value: string\n}\n`)
    await writeFile(join(dir, 'src/nested/shape.ts'), `export interface Shape {\n  sides: number\n}\n`)
    await writeFile(join(dir, 'src/utils.ts'), `export const myModuleUtils = (): void => {}\n`)
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, imports: { '#payload': './src/nested/payload.ts' } }))
    await writeFile(join(dir, 'src/module.ts'), [
      `import { defineNuxtModule } from '@nuxt/kit'`,
      `import type { NuxtModule } from '@nuxt/schema'`,
      `import type { Payload } from '#payload'`,
      `import type { Shape } from './nested/shape.ts'`,
      ``,
      `export interface ModuleOptions {\n  payload?: Payload\n  shape?: Shape\n}`,
      ``,
      `const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({ meta: { name: 'my-module', configKey: 'myModule' } })`,
      ``,
      `export default module`,
      ``,
    ].join('\n'))
    await writeFile(join(dir, 'src/runtime/composables/usePayload.ts'), `import type { ModuleOptions } from 'my-module'\n\nexport const usePayload = (options: ModuleOptions): string | undefined => options.payload?.value\n`)
    await writeFile(join(dir, 'tsconfig.module.json'), JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { isolatedDeclarations: true, declaration: true, allowJs: false } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./tsconfig.module.json')))
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    expect(prepared.stdout + prepared.stderr).not.toContain('The build reports the same errors')
    expect(await readFile(join(dir, '.nuxt/module-builder/declarations/src/nested/payload.d.ts'), 'utf-8')).toContain('interface Payload')
    const moduleDeclaration = await readFile(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'), 'utf-8')
    expect(moduleDeclaration).toContain('from "./nested/payload.js"')
    expect(moduleDeclaration).toContain('from "./nested/shape.js"')
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-b', '--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout + typecheck.stderr).toBe('')
    const listed = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['-p', '.nuxt/tsconfig.app.json', '--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })
    expect(listed.stdout).toContain(join(dir, '.nuxt/module-builder/declarations/src/nested/payload.d.ts'))
    expect(listed.stdout).not.toContain(join(dir, 'src/nested/payload.ts'))
    expect(listed.stdout).not.toContain(join(dir, 'src/nested/shape.ts'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should warn about a declaration error in module code at prepare, and write the other declarations', async () => {
    const dir = await copyExample('.temp-tsdown-references-own-package-error', 'export default { plugins: [builder()] }\n')
    const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`
    const files = {
      [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
      'src/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n`,
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true })
      await writeFile(join(dir, file), contents)
    }
    await symlink(join(dir, store('fake-logger')), join(dir, 'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger'))
    await symlink(join(dir, store('fake-shared')), join(dir, 'node_modules/fake-shared'))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')))
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    expect(prepared.stdout + prepared.stderr).toContain('The build reports the same errors')
    expect(prepared.stdout + prepared.stderr).toContain('src/logger.ts(3,14): error TS2883')
    expect(existsSync(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))).toBe(true)
    expect(existsSync(join(dir, '.nuxt/module-builder/declarations/types.d.mts'))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('should keep `.nuxt/tsconfig.json` one program over the module\'s sources, with the generated tsconfigs adapted', async () => {
    const dir = await copyExample('.temp-tsdown-references-legacy-prepare', 'export default { plugins: [builder()] }\n')
    const moduleSrc = join(dir, 'src/module.ts')
    await writeFile(moduleSrc, (await readFile(moduleSrc, 'utf-8'))
      .replace('import { defineNuxtModule, addPlugin, createResolver } from \'@nuxt/kit\'', 'import { defineNuxtModule, addPlugin, addTypeTemplate, createResolver } from \'@nuxt/kit\'')
      .replace('    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))', '    addPlugin(resolver.resolve(\'./runtime/plugins/plugin\'))\n    addTypeTemplate({ filename: \'types/my-module.d.ts\', getContents: () => \'import type { ModuleOptions } from "my-module"\\ndeclare module "#app" {\\n  interface NuxtApp {\\n    $myModuleOptions: ModuleOptions\\n  }\\n}\\nexport {}\\n\' })\n    const configured: unknown = _nuxt.options.myModule\n    void configured\n    void _nuxt.callHook(\'my-module:init\', \'shared-type\')'))
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    await writeFile(join(dir, 'src/runtime/server/options.ts'), `export const apiKey = (options: { apiKey: string }): string => options.apiKey\n`)
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './.nuxt/tsconfig.json', exclude: ['dist', 'node_modules', 'playground', 'tsdown.config.ts', 'nuxt.config.ts'] }))
    await writeFile(join(dir, 'nuxt.config.ts'), `export default { buildDir: '.nuxt-custom' }\n`)
    await rm(join(dir, '.nuxt'), { recursive: true, force: true })
    const prepared = await exec('node', [join(repoRoot, 'src/cli.ts'), 'prepare', dir], { nodeOptions: { env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })
    expect(prepared.exitCode, prepared.stdout + prepared.stderr).toBe(0)
    const generated = async (name: string) => JSON.parse(await readFile(join(dir, `.nuxt/${name}.json`), 'utf-8'))
    expect((await generated('tsconfig.app')).compilerOptions.paths['my-module']).toEqual(['./module-builder/declarations/types.d.mts'])
    const legacy = await generated('tsconfig')
    expect(legacy.compilerOptions.paths['my-module']).toBeUndefined()
    expect(legacy.include).not.toContain('./module-builder/declarations/types.d.mts')
    expect(legacy.exclude).not.toContain('../src/runtime/server')
    const typecheck = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['--noEmit'], { nodeOptions: { cwd: dir } })
    expect(typecheck.stdout).not.toMatch(/error TS5\d{3}/)
    expect(typecheck.stdout.split('\n').filter(line => /^(?:src|\.nuxt)\//.test(line))).toEqual([])
    const listed = await exec(join(repoRoot, 'node_modules/.bin/vue-tsc'), ['--noEmit', '--listFilesOnly'], { nodeOptions: { cwd: dir } })
    expect(listed.stdout).toContain(join(dir, 'src/module.ts'))
    expect(listed.stdout).toContain(join(dir, 'src/runtime/server/options.ts'))
    expect(listed.stdout).not.toContain(join(dir, '.nuxt/module-builder/declarations/src/module.d.ts'))
    await rm(dir, { recursive: true, force: true })
  })

  it('should name a dependency in runtime declarations by its package when only another part of the module imports it', async () => {
    const dir = await copyExample('.temp-tsdown-references-portable', 'export default { plugins: [builder()] }\n')
    const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`
    const files = {
      [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
      [`${store('fake-logger')}/index.js`]: `export const createLogger = () => ({ log: console.log })\n`,
      [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
      [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
      [`${store('fake-shared')}/index.js`]: `import { createLogger } from 'fake-logger'\nexport const createModuleLogger = () => createLogger()\n`,
      'src/runtime/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n`,
      'src/runtime/server/log.ts': `import { createLogger } from 'fake-logger'\n\nexport const serverLogger = createLogger()\n`,
    }
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(dir, file)), { recursive: true })
      await writeFile(join(dir, file), contents)
    }
    await symlink(join(dir, store('fake-logger')), join(dir, 'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger'))
    for (const name of ['fake-logger', 'fake-shared']) {
      await symlink(join(dir, store(name)), join(dir, 'node_modules', name))
    }
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, 'fake-logger': '1.0.0', 'fake-shared': '1.0.0' } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')))
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(await readFile(join(dir, 'dist/runtime/logger.d.ts'), 'utf-8')).toContain('import("fake-logger").LoggerInstance')
    await rm(dir, { recursive: true, force: true })
  })

  it('should transform each runtime file with the referenced project that includes it', async () => {
    const dir = await copyExample('.temp-tsdown-references-transforms', 'export default { plugins: [builder()] }\n')
    await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
    const source = `class Fields { value!: string }\nexport const ownsField: boolean = Object.hasOwn(new Fields(), 'value')\n`
    await writeFile(join(dir, 'src/runtime/fields.ts'), source)
    await writeFile(join(dir, 'src/runtime/server/fields.ts'), source)
    await writeFile(join(dir, 'tsconfig.server.json'), JSON.stringify({ extends: './.nuxt/tsconfig.server.json', compilerOptions: { useDefineForClassFields: false } }))
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(references('./.nuxt/tsconfig.node.json')).replace('./.nuxt/tsconfig.server.json', './tsconfig.server.json'))
    const built = await tsdown(dir)
    expect(built.exitCode, built.stdout + built.stderr).toBe(0)
    expect(await readFile(join(dir, 'dist/runtime/fields.js'), 'utf-8')).toContain('\tvalue;')
    expect(await readFile(join(dir, 'dist/runtime/server/fields.js'), 'utf-8')).not.toContain('value;')
    await rm(dir, { recursive: true, force: true })
  })
})
