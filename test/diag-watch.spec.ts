import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'pathe'
import { exec } from 'tinyexec'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const exampleDir = join(repoRoot, 'example')
const diagDir = join(repoRoot, '.diag')
const tsdownBin = join(repoRoot, 'node_modules/tsdown/dist/run.mjs')
const rolldownUrl = pathToFileURL(createRequire(join(repoRoot, 'node_modules/tsdown/package.json')).resolve('rolldown')).href
const preloadUrl = pathToFileURL(join(repoRoot, 'test/diag-preload.mjs')).href
const builderImport = `import { builder } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src/tsdown/index.ts')).href)}`
const RD_LOG = 'notify=trace,rolldown_watcher=trace,rolldown_fs_watcher=trace,rolldown_binding::watcher=debug,rolldown_plugin::plugin_driver=trace'

const rolldownScript = (dirWatch: boolean) => [
  `import { resolve } from 'node:path'`,
  `import { watch } from ${JSON.stringify(rolldownUrl)}`,
  `const watcher = watch({ input: 'src/utils.ts', output: { dir: 'dist-rd' }, plugins: [{ name: 'dir', buildStart() { ${dirWatch ? `this.addWatchFile(resolve('src/runtime'))` : ''} } }] })`,
  `watcher.on('event', (event) => { console.log('[rd]', event.code, event.error?.message ?? ''); if (event.result) event.result.close() })`,
  '',
].join('\n')

interface Probe {
  name: string
  config?: string
  script?: string
  watch?: boolean
  marker: string
  env?: Record<string, string>
}

const probes: Probe[] = [
  { name: 'control-build-no-watch', config: `export default { plugins: [builder()] }\n`, watch: false, marker: 'dist/module.json' },
  { name: 'rolldown-watch', script: rolldownScript(false), marker: 'dist-rd/utils.js' },
  { name: 'rolldown-watch-dir', script: rolldownScript(true), marker: 'dist-rd/utils.js' },
  { name: 'tsdown-watch-no-dts', config: `export default { entry: ['src/utils.ts'], dts: false }\n`, marker: 'dist/utils.mjs' },
  { name: 'tsdown-watch-dts', config: `export default { entry: ['src/utils.ts'], dts: true }\n`, marker: 'dist/utils.d.mts' },
  { name: 'builder-watch', config: `export default { plugins: [builder()] }\n`, marker: 'dist/module.json' },
  { name: 'builder-watch-no-dir-watch', config: `export default { plugins: [builder()] }\n`, marker: 'dist/module.json', env: { DIAG_NO_DIR_WATCH: '1' } },
  { name: 'builder-watch-no-source-watch', config: `export default { plugins: [builder()] }\n`, marker: 'dist/module.json', env: { DIAG_NO_SOURCE_WATCH: '1' } },
  { name: 'builder-watch-no-glob-watch', config: `export default { plugins: [builder()] }\n`, marker: 'dist/module.json', env: { DIAG_NO_GLOB_WATCH: '1' } },
  { name: 'builder-watch-no-watch-files', config: `export default { plugins: [builder()] }\n`, marker: 'dist/module.json', env: { DIAG_NO_DIR_WATCH: '1', DIAG_NO_SOURCE_WATCH: '1', DIAG_NO_GLOB_WATCH: '1' } },
]

async function copyExample(name: string) {
  const dir = join(repoRoot, `.temp-diag-${name}`)
  await rm(dir, { recursive: true, force: true })
  await cp(exampleDir, dir, { recursive: true })
  await rm(join(dir, 'dist'), { recursive: true, force: true })
  const pkgPath = join(dir, 'package.json')
  const { build: _, ...pkg } = JSON.parse(await readFile(pkgPath, 'utf-8'))
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  return dir
}

describe('windows watch diagnostics', () => {
  beforeAll(async () => {
    await mkdir(diagDir, { recursive: true })
  })

  it.each(probes)('$name', async (probe) => {
    const dir = await copyExample(probe.name)
    let args: string[]
    if (probe.script) {
      await writeFile(join(dir, 'probe.mjs'), probe.script)
      args = ['probe.mjs']
    }
    else {
      await writeFile(join(dir, 'tsdown.config.ts'), `${builderImport}\n${probe.config}`)
      args = probe.watch === false ? [tsdownBin] : [tsdownBin, '--watch']
    }
    const env = { ...process.env, NODE_ENV: '', TEST: '', NO_COLOR: '1', FORCE_COLOR: '0', RD_LOG, DEBUG: 'tsdown:*,rolldown-plugin-dts:*', DIAG_REPORT: join(diagDir, `${probe.name}.report.json`), ...probe.env }
    const startedAt = Date.now()
    const result = exec('node', ['--import', preloadUrl, ...args], { nodeOptions: { cwd: dir, env } })
    let output = ''
    for (const stream of [result.process?.stdout, result.process?.stderr]) {
      stream?.on('data', (chunk) => {
        output += chunk
      })
    }
    let exited = false
    result.then(() => {}, () => {}).finally(() => {
      exited = true
    })
    const marker = join(dir, probe.marker)
    while (!existsSync(marker) && !exited && Date.now() - startedAt < 60_000) {
      await delay(250)
    }
    const ok = existsSync(marker)
    const elapsed = Date.now() - startedAt
    const exitedEarly = exited
    if (!exited) {
      await delay(ok ? 1000 : 0)
      result.kill()
      await result.then(() => {}, () => {})
    }
    await writeFile(join(diagDir, `${probe.name}.log`), `ok=${ok} elapsed=${elapsed}ms exitedEarly=${exitedEarly} exitCode=${result.exitCode}\n\n${output}`)
    console.log(`[diag] ${probe.name}: ok=${ok} elapsed=${elapsed}ms exitedEarly=${exitedEarly}\n${output.split('\n').filter(line => !/^\s/.test(line) && !/ (?:TRACE|DEBUG) /.test(line)).slice(-15).join('\n')}`)
    expect(ok).toBe(true)
  }, 120_000)
})
