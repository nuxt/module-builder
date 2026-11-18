import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { join, relative } from 'pathe'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { TestContext } from 'vitest'

import { escapeRegExp } from '../src/utils.ts'
import type { PackageJson } from '../src/utils.ts'
import { builderImport, exists, fixture, read, repoRoot, run, succeed, tsdown, tsdownBin, waitFor, watch } from './utils.ts'

const PLUGIN = `export default {\n  plugins: [builder()],\n}\n`
const tsdownApi = JSON.stringify(pathToFileURL(join(repoRoot, 'node_modules/tsdown/dist/index.mjs')).href)
const withoutConfig = { config: false, pkg: ({ build: _, ...pkg }: PackageJson) => pkg } as const
const sizeRows = (output: string) => [...output.matchAll(/(dist\/(?:module\.mjs|runtime\/))\s[^\n]*types/g)].map(match => match[1]).sort()

async function outputs(dir: string) {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(file => file.isFile())
  return new Map(await Promise.all(files.map(async (file) => {
    const path = join(file.parentPath, file.name)
    return [relative(dir, path), { mtime: (await stat(path, { bigint: true })).mtimeNs, hash: createHash('sha256').update(await readFile(path)).digest('hex') }] as const
  })))
}

describe.concurrent('tsdown --watch', () => {
  describe('with a module whose entry imports runtime code', () => {
    let dir: string
    let watcher: ReturnType<typeof watch>
    const dist = (file: string) => join(dir, 'dist', file)
    let previous = Promise.resolve()
    const finished: Array<() => void> = []
    const inOrder = (test: () => Promise<void>) => {
      const prior = previous
      let done!: () => void
      previous = new Promise<void>((resolve) => {
        done = resolve
      })
      finished.push(done)
      return ({ task }: TestContext) => {
        task.suite!.tasks.forEach((sibling, index) => {
          if (sibling.mode === 'skip' || sibling.mode === 'todo') {
            finished[index]!()
          }
        })
        return prior.then(test).finally(done)
      }
    }

    beforeAll(async () => {
      dir = await fixture('.temp-watch/module', {
        config: PLUGIN,
        module: source => `import { moduleName } from './runtime/name.ts'\n${source.replace(`name: 'my-module'`, 'name: moduleName')}`,
        files: {
          'src/runtime/name.ts': `export const moduleName: string = 'from-runtime'\n`,
          'src/runtime/removed.ts': `export const removed: string = 'removed'\n`,
          'src/shared.ts': `export const shared: string = 'first'\n`,
          'src/runtime/use.ts': `import { shared } from '../shared'\n\nexport const useShared = (): string => shared\n`,
        },
      })
      watcher = watch(dir, [tsdownBin, '--watch'], () => {})
      await waitFor(() => exists(dist('module.json')) && exists(dist('types.d.mts')))
    })

    afterAll(() => watcher?.stop())

    afterEach(({ task }) => {
      if (task.result?.state === 'fail') {
        console.error(`Output of \`tsdown --watch\`:\n${watcher.output().slice(-8000)}`)
      }
    })

    it('should report the size of each entry and runtime directory once', inOrder(async () => {
      await waitFor(async () => sizeRows(watcher.output()).length >= 2 && exists(dist('types.d.mts')) && exists(dist('module.json')))
      await delay(1000)
      expect(sizeRows(watcher.output())).toEqual(['dist/module.mjs', 'dist/runtime/'])
      expect(JSON.parse(await read(dist('module.json'))).name).toBe('from-runtime')
    }))

    it('should rewrite `module.json` when a file the module entry imports changes', inOrder(async () => {
      await writeFile(join(dir, 'src/runtime/name.ts'), `export const moduleName: string = 'changed-runtime'\n`)
      await waitFor(async () => JSON.parse(await read(dist('module.json'))).name === 'changed-runtime')
    }))

    it('should rebuild when a file is added to the runtime directory', inOrder(async () => {
      await mkdir(join(dir, 'src/runtime/utils/nested'), { recursive: true })
      await writeFile(join(dir, 'src/runtime/utils/nested/added.ts'), `export const added: string = 'added'\n`)
      await waitFor(() => exists(dist('runtime/utils/nested/added.js')) && exists(dist('runtime/utils/nested/added.d.ts')))
    }))

    it('should compile JSX in a server runtime file added', inOrder(async () => {
      await mkdir(join(dir, 'src/runtime/server'), { recursive: true })
      await writeFile(join(dir, 'src/runtime/server/render.tsx'), `export const render = (): unknown => <p>hi</p>\n`)
      await waitFor(() => exists(dist('runtime/server/render.js')) || exists(dist('runtime/server/render.jsx')))
      expect(exists(dist('runtime/server/render.jsx'))).toBe(false)
      expect(await read(dist('runtime/server/render.js'))).toContain('vue/jsx-runtime')
    }))

    it('should rebuild when a file outside the runtime directory that a runtime file imports changes', inOrder(async () => {
      await waitFor(async () => (await read(dist('shared.js'))).includes('first'))
      await writeFile(join(dir, 'src/shared.ts'), `export const shared: string = 'second'\n`)
      await waitFor(async () => (await read(dist('shared.js'))).includes('second'))
    }))

    it('should remove the output of a deleted runtime file', inOrder(async () => {
      expect(exists(dist('runtime/removed.js'))).toBe(true)
      await rm(join(dir, 'src/runtime/removed.ts'))
      await waitFor(() => !exists(dist('runtime/removed.js')) && !exists(dist('runtime/removed.d.ts')))
      expect(exists(dist('runtime/plugins/plugin.js'))).toBe(true)
    }))

    it('should rewrite `#app` in an added declaration file', inOrder(async () => {
      await writeFile(join(dir, 'src/runtime/composables/added.d.ts'), `import type { NuxtApp } from '#app'\nexport type Added = NuxtApp\n`)
      await waitFor(async () => exists(dist('runtime/composables/added.d.ts')) && (await read(dist('runtime/composables/added.d.ts'))).includes(`from 'nuxt/app'`))
    }))

    it('should rewrite `types.d.mts` and report sizes once when the module entry changes', inOrder(async () => {
      const seen = watcher.output().length
      await writeFile(join(dir, 'src/module.ts'), `${await read(dir, 'src/module.ts')}\nexport const rebuiltMarker: string = 'rebuilt'\n`)
      await waitFor(async () => (await read(dist('types.d.mts'))).includes('rebuiltMarker') && sizeRows(watcher.output().slice(seen)).length >= 2)
      await delay(1000)
      expect(sizeRows(watcher.output().slice(seen))).toEqual(['dist/module.mjs', 'dist/runtime/'])
      expect(JSON.parse(await read(dist('module.json'))).name).toBe('changed-runtime')
    }))

    for (const [target, file, recovered] of [
      ['the module entry', 'src/module.ts', 'types.d.mts'],
      ['a runtime file', 'src/runtime/plugins/plugin.ts', 'runtime/plugins/plugin.js'],
    ] as const) {
      it(`should keep the previous output when a rebuild of ${target} fails, and recover on the next good save`, inOrder(async () => {
        const files = ['module.mjs', 'module.d.mts', 'module.json', 'types.d.mts', 'runtime/plugins/plugin.js'].map(dist)
        const source = await read(dir, file)
        const before = await Promise.all(files.map(output => read(output)))
        const seen = watcher.output().length
        await writeFile(join(dir, file), `${source}\nexport const broken = (\n`)
        await waitFor(() => /error/i.test(watcher.output().slice(seen)))
        await delay(1000)
        expect(await Promise.all(files.map(output => read(output)))).toEqual(before)
        await writeFile(join(dir, file), `${source}\nexport const recoveredMarker: string = 'recovered'\n`)
        await waitFor(async () => (await read(dist(recovered))).includes('recoveredMarker'))
      }))
    }
  })

  it('should rebuild when a file is added to a missing runtime directory', async ({ onTestFailed }) => {
    const dir = await fixture('.temp-watch/without-runtime', {
      config: PLUGIN,
      remove: ['src/runtime'],
      module: `import { defineNuxtModule } from '@nuxt/kit'\n\nexport default defineNuxtModule({ meta: { name: 'my-module' } })\n`,
    })
    const watcher = watch(dir, [tsdownBin, '--watch'], onTestFailed)
    try {
      await waitFor(() => exists(dir, 'dist/module.json'))
      await mkdir(join(dir, 'src/runtime/utils'), { recursive: true })
      await writeFile(join(dir, 'src/runtime/utils/added.ts'), `export const added: string = 'added'\n`)
      await waitFor(() => exists(dir, 'dist/runtime/utils/added.js') && exists(dir, 'dist/runtime/utils/added.d.ts'))
    }
    finally {
      await watcher.stop()
    }
  })

  it('should keep `dist` while a watched build starts, and empty it before a one-off build', async ({ onTestFailed }) => {
    const dir = await fixture('.temp-watch/kept', { config: PLUGIN })
    const distDir = join(dir, 'dist')
    const stale = ['stale.txt', 'runtime/components/Removed.vue']
    const addStale = () => Promise.all(stale.map(file => writeFile(join(distDir, file), 'stale\n')))

    await succeed(tsdown(dir))
    await addStale()
    await succeed(tsdown(dir))
    expect(stale.filter(file => exists(distDir, file))).toEqual([])

    await addStale()
    const before = await outputs(distDir)
    const watcher = watch(dir, [tsdownBin, '--watch'], onTestFailed)
    let missing = false
    try {
      await waitFor(async () => {
        missing ||= !exists(distDir, 'module.mjs') || !exists(distDir, 'runtime/plugins/plugin.js')
        return /Rebuilt in/.test(watcher.output())
      })
      const after = await outputs(distDir)
      expect(missing).toBe(false)
      expect([...before.keys()].filter(file => !after.has(file)).sort()).toEqual([...stale].sort())
      expect([...after.keys()].filter(file => before.get(file)!.mtime !== after.get(file)!.mtime && !file.endsWith('.d.ts'))).toEqual([])
    }
    finally {
      await watcher.stop()
    }
  })

  it('should only write the outputs whose content changes', async ({ onTestFailed }) => {
    const dir = await fixture('.temp-watch/unchanged', {
      config: `export default {\n  plugins: [\n    builder({ entries: ['./src/utils'] }),\n    { name: 'user-asset', generateBundle() { this.emitFile({ type: 'asset', fileName: 'user.txt', source: 'user asset\\n' }) } },\n  ],\n}\n`,
    })
    const distDir = join(dir, 'dist')
    const changes = (before: Awaited<ReturnType<typeof outputs>>, after: Awaited<ReturnType<typeof outputs>>) => ({
      changed: [...after.keys()].filter(file => before.has(file) && before.get(file)!.mtime !== after.get(file)!.mtime).sort(),
      added: [...after.keys()].filter(file => !before.has(file)).sort(),
      removed: [...before.keys()].filter(file => !after.has(file)).sort(),
    })
    const watcher = watch(dir, [tsdownBin, '--watch'], onTestFailed)
    const rebuilds = () => watcher.output().match(/Rebuilt in/g)?.length ?? 0
    const rebuild = async (change: () => Promise<void>, file?: string) => {
      const before = await outputs(distDir)
      const count = rebuilds()
      const seen = watcher.output().length
      const rebuilt = file && new RegExp(`Found [^\\n]*${escapeRegExp(file)}[^\\n]* changed[\\s\\S]*Rebuilt in`)
      await change()
      await waitFor(() => rebuilt ? rebuilt.test(watcher.output().slice(seen).replaceAll('\\', '/')) : rebuilds() > count)
      return changes(before, await outputs(distDir))
    }
    const edit = (file: string, from: string, to: string) => rebuild(async () => writeFile(join(dir, file), (await read(dir, file)).replace(from, to)), file)
    try {
      await waitFor(() => rebuilds() > 0 && exists(distDir, 'module.json') && exists(distDir, 'types.d.mts'))
      expect(await read(distDir, 'user.txt')).toBe('user asset\n')

      await rm(join(distDir, 'runtime/plugins/plugin.js'))
      expect(await edit('src/runtime/components/TestMe.vue', '', '')).toEqual({ changed: [], added: ['runtime/plugins/plugin.js'], removed: [] })

      expect(await edit('src/runtime/components/TestMe.vue', '{{ count }}', 'count: {{ count }}')).toEqual({ changed: ['runtime/components/TestMe.vue'], added: [], removed: [] })
      expect(await edit('src/runtime/components/TestMe.vue', '', '')).toEqual({ changed: [], added: [], removed: [] })
      expect(await edit('src/module.ts', `name: 'my-module'`, `name: 'my-renamed-module'`)).toEqual({ changed: ['module.json', 'module.mjs'], added: [], removed: [] })
      expect(await rebuild(() => rm(join(dir, 'src/runtime/composables/useAppNuxt.ts')))).toEqual({ changed: [], added: [], removed: ['runtime/composables/useAppNuxt.d.ts', 'runtime/composables/useAppNuxt.js'] })

      const before = await outputs(distDir)
      const plugin = await read(dir, 'src/runtime/plugins/plugin.ts')
      const failures = () => watcher.output().match(/Failed to transpile/g)?.length ?? 0
      const failed = failures()
      await writeFile(join(dir, 'src/runtime/plugins/plugin.ts'), `${plugin}\nexport const broken: = 1\n`)
      await waitFor(() => failures() > failed)
      expect(changes(before, await outputs(distDir))).toEqual({ changed: [], added: [], removed: [] })
      expect(await rebuild(() => writeFile(join(dir, 'src/runtime/plugins/plugin.ts'), plugin), 'src/runtime/plugins/plugin.ts')).toEqual({ changed: [], added: [], removed: [] })
      expect([...(await outputs(distDir)).entries()].map(([file, { hash }]) => [file, hash])).toEqual([...before.entries()].map(([file, { hash }]) => [file, hash]))
    }
    finally {
      await watcher.stop()
    }
  })

  it('should not keep more memory with each rebuild', async () => {
    const dir = await fixture('.temp-watch/memory', withoutConfig)
    const file = join(dir, 'src/runtime/composables/useWrappedFetch.ts')
    await mkdir(join(dir, 'src/shared'), { recursive: true })
    await writeFile(join(dir, 'src/shared/format.ts'), `export const format = (value: string): string => value.trim()\n`)
    await writeFile(join(dir, 'watch.mjs'), [
      `import { readFileSync, writeFileSync } from 'node:fs'`,
      `import { build } from ${tsdownApi}`,
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
    const { stdout, exitCode, output } = await run('node', ['--expose-gc', 'watch.mjs'], { cwd: dir })
    expect(exitCode, output).toBe(0)
    const heap = JSON.parse(stdout.trim().split('\n').at(-1)!) as number[]
    expect(heap.at(-1)! - heap[2]!).toBeLessThan(64 * 1024 * 1024)
  })

  it('should write current metadata from each build session in the same process', async () => {
    const dir = await fixture('.temp-watch/sessions', withoutConfig)
    await writeFile(join(dir, 'sessions.mjs'), [
      `import { readFile, writeFile } from 'node:fs/promises'`,
      `import { build } from ${tsdownApi}`,
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
    const { stdout, exitCode, output } = await run('node', ['sessions.mjs'], { cwd: dir })
    expect(exitCode, output).toBe(0)
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual(['first-session', 'second-session'])
  })
})
