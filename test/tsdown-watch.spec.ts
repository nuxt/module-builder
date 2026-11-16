import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { join, relative } from 'pathe'
import { exec } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { builderImport, copyExample, repoRoot, tsdown, tsdownBin, waitFor, watch } from './utils.ts'

describe('builder', () => {
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
      `let built, idle, started`,
      `const settled = { name: 'settled', buildStart() { started = true; clearTimeout(idle) }, writeBundle: { order: 'post', handler() { idle = setTimeout(() => started && built(), 250) } } }`,
      `const handle = await build({ cwd: ${JSON.stringify(dir)}, config: false, watch: true, logLevel: 'silent', plugins: [builder({ entries: [{ input: 'src/shared/', outDir: 'dist/shared' }] }), settled] })`,
      `const heap = []`,
      `for (let round = 0; round < 6; round++) {`,
      `  await new Promise(resolve => { built = resolve; started = false; writeFileSync(${JSON.stringify(file)}, source + 'export const round = ' + round + '\\n') })`,
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
})
