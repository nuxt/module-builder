import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'pathe'
import { exec } from 'tinyexec'
import { onTestFailed } from 'vitest'

import { publishedPackage } from '../src/build/package.ts'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const exampleDir = join(repoRoot, 'example')
export const tsdownBin = join(repoRoot, 'node_modules/tsdown/dist/run.mjs')
export const builderImport = `import { builder } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src/tsdown/index.ts')).href)}`

export async function copyExample(name: string, config: string) {
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

export const tsdown = (cwd: string, args: string[] = [], env: Record<string, string> = {}) => exec('node', [tsdownBin, ...args], { nodeOptions: { cwd, env: { ...process.env, NODE_ENV: '', TEST: '', ...env } } })

export function watch(cwd: string, args: string[]) {
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

export async function waitFor(check: () => Promise<boolean>, timeout = 60_000) {
  const end = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > end) {
      throw new Error('Timed out')
    }
    await delay(250)
  }
}
