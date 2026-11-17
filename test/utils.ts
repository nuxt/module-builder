import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'pathe'
import { exec } from 'tinyexec'
import ts from 'typescript'
import { onTestFailed } from 'vitest'

import { publishedPackage } from '../src/build/package.ts'
import type { PackageJson } from '../src/utils.ts'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** The static `import` declarations of `code`. */
export function staticImports(code: string): Array<{ specifier: string, code: string }> {
  const source = ts.createSourceFile('module.ts', code, ts.ScriptTarget.Latest)
  return source.statements.filter(ts.isImportDeclaration).map(statement => ({ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, code: statement.getText(source) }))
}
export const exampleDir = join(repoRoot, 'example')
export const tsdownBin = join(repoRoot, 'node_modules/tsdown/dist/run.mjs')
export const cliBin = join(repoRoot, 'src/cli.ts')
export const bin = (name: string) => join(repoRoot, 'node_modules/.bin', name)
export const builderImport = `import { builder } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src/tsdown/index.ts')).href)}`
const buildEnv = { NODE_ENV: '', TEST: '', NUXT_TELEMETRY_DISABLED: '1' }

export interface Result {
  output: string
  stdout: string
  exitCode: number | undefined
}

/** Directories that hold one slot each of the processes that every spec file runs at once. */
const slotsDir = join(repoRoot, '.temp-slots')

async function acquireSlot(): Promise<string> {
  for (;;) {
    for (let index = 0; index < availableParallelism(); index++) {
      const slot = join(slotsDir, String(index))
      try {
        await mkdir(slot)
        return slot
      }
      catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code === 'ENOENT') {
          await mkdir(slotsDir, { recursive: true })
        }
        else if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
          throw error
        }
      }
    }
    await delay(50 + Math.random() * 50)
  }
}

/**
 * Runs a command with at most one process per CPU at a time across spec files, and resolves
 * with its combined output.
 */
export async function run(command: string, args: string[], { cwd = repoRoot, env = {} }: { cwd?: string, env?: Record<string, string | undefined> } = {}): Promise<Result> {
  const slot = await acquireSlot()
  try {
    const result = await exec(command, args, { nodeOptions: { cwd, env: { ...process.env, ...buildEnv, ...env } } })
    return { output: result.stdout + result.stderr, stdout: result.stdout, exitCode: result.exitCode }
  }
  finally {
    await rm(slot, { recursive: true, force: true })
  }
}

export const cli = (args: string[], env?: Record<string, string | undefined>) => run('node', [cliBin, ...args], { env })

export const tsdown = (cwd: string, args: string[] = [], env?: Record<string, string | undefined>) => run('node', [tsdownBin, ...args], { cwd, env })

export async function succeed(result: Promise<Result> | Result): Promise<string> {
  const { output, exitCode } = await result
  if (exitCode !== 0) {
    throw new Error(`Exited with ${exitCode}:\n${output}`)
  }
  return output
}

type Contents = string | ((source: string) => string)

export interface FixtureOptions {
  /** The directory to copy, `example` by default. */
  from?: string
  /**
   * The tsdown config, after an import of `builder`. `false` leaves the module without one and
   * keeps the `build` field of `package.json`.
   */
  config?: string | false
  /** The source of `src/module.ts`, or a transform of it. */
  module?: Contents
  /** Files to write, relative to the fixture, as contents or a transform of the existing file. */
  files?: Record<string, Contents>
  /** Files and directories to remove, before `files` are written. */
  remove?: string[]
  /** A transform of `package.json`. */
  pkg?: (pkg: PackageJson) => PackageJson
  /** `paths` to merge into `.nuxt/tsconfig.json`. */
  paths?: Record<string, string[]>
  /** Symlinks to create, as link to target, relative to the fixture. */
  links?: Record<string, string>
}

const DEFAULT_CONFIG = `export default {\n  plugins: [builder({ entries: ['./src/utils'] })],\n}\n`

/**
 * Copies `example` to `dir` under the repository, without `dist`, with `package.json` as it is
 * published and a tsdown config that builds it with `builder()`.
 */
export async function fixture(dir: string, { from = exampleDir, config = DEFAULT_CONFIG, module, files = {}, remove = [], pkg, paths, links = {} }: FixtureOptions = {}): Promise<string> {
  const root = join(repoRoot, dir)
  await rm(root, { recursive: true, force: true })
  await mkdir(dirname(root), { recursive: true })
  await cp(from, root, { recursive: true })
  await rm(join(root, 'dist'), { recursive: true, force: true })
  const pkgPath = join(root, 'package.json')
  const { build, publishConfig: _, ...published } = publishedPackage(JSON.parse(await readFile(pkgPath, 'utf-8')))
  const copied = config === false ? { ...published, build } : published
  await writeFile(pkgPath, JSON.stringify(pkg ? pkg(copied) : copied, null, 2))
  if (config !== false) {
    await writeFile(join(root, 'tsdown.config.ts'), `${builderImport}\n${config}`)
  }
  for (const file of remove) {
    await rm(join(root, file), { recursive: true, force: true })
  }
  for (const [file, contents] of Object.entries({ ...module !== undefined && { 'src/module.ts': module }, ...files })) {
    const path = join(root, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, typeof contents === 'function' ? contents(await readFile(path, 'utf-8')) : contents)
  }
  if (paths) {
    const tsconfig = join(root, '.nuxt/tsconfig.json')
    const config = JSON.parse(await readFile(tsconfig, 'utf-8'))
    config.compilerOptions.paths = { ...config.compilerOptions.paths, ...paths }
    await writeFile(tsconfig, JSON.stringify(config, null, 2))
  }
  const playgroundLink = existsSync(join(root, 'playground/node_modules')) ? { 'playground/node_modules/my-module': '.' } : {}
  for (const [link, target] of Object.entries({ ...playgroundLink, ...links })) {
    await mkdir(dirname(join(root, link)), { recursive: true })
    await rm(join(root, link), { recursive: true, force: true })
    await symlink(join(root, target), join(root, link))
  }
  return root
}

export const listFiles = async (dir: string) => (await readdir(dir, { recursive: true })).map(file => file.replaceAll('\\', '/')).sort()

export const read = (...segments: string[]) => readFile(join(...segments), 'utf-8')

export const exists = (...segments: string[]) => existsSync(join(...segments))

export async function unresolvedSpecifiers(dir: string) {
  const failures: string[] = []
  for (const entry of await listFiles(dir)) {
    if (!/\.d\.[^/]*ts$/.test(entry)) {
      continue
    }
    const file = join(dir, entry)
    for (const [, specifier] of (await readFile(file, 'utf-8')).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]*)['"]/g)) {
      const target = join(dirname(file), specifier!)
      const candidates = /\.jsx?$/.test(specifier!)
        ? [target.replace(/\.jsx?$/, '.d.ts')]
        : specifier!.endsWith('.mjs')
          ? [target.replace(/\.mjs$/, '.d.mts')]
          : specifier!.endsWith('.vue')
            ? [`${target}.d.ts`, target.replace(/\.vue$/, '.d.vue.ts')]
            : specifier!.endsWith('.css') ? [target] : []
      if (!candidates.some(candidate => existsSync(candidate))) {
        failures.push(`${entry}: ${specifier}`)
      }
    }
  }
  return failures
}

export function watch(cwd: string, args: string[], onFailed: typeof onTestFailed = onTestFailed) {
  const result = exec('node', args, { nodeOptions: { cwd, env: { ...process.env, ...buildEnv } } })
  let output = ''
  onFailed(() => {
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

export async function waitFor(check: () => Promise<boolean> | boolean, timeout = 60_000) {
  const end = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > end) {
      throw new Error('Timed out')
    }
    await delay(250)
  }
}
