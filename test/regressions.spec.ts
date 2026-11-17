import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { consola } from 'consola'
import { join } from 'pathe'
import { exec } from 'tinyexec'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { analyseSources, hashGeneratedTypes } from '../src/build/build.ts'
import type { BuildPlan } from '../src/build/build.ts'
import { resolveModuleOptions, resolveOutDir, translateBuildConfig } from '../src/build/build-config.ts'
import { checkLegacyCJSPaths } from '../src/build/deprecations.ts'
import { selfReferencePaths } from '../src/build/tsconfig.ts'
import { resolveCwdArg } from '../src/commands/_shared.ts'
import { moduleSpecifiers, valueSpecifiers } from '../src/rolldown/resolve.ts'
import { relativeSpecifier } from '../src/utils.ts'
import { copyExample, repoRoot } from './utils.ts'

const temp: string[] = []
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'module-builder-regressions-'))
  temp.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(temp.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('regressions', () => {
  it('should resolve a module root reached through a symlink to its real path', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'real'))
    await symlink(join(dir, 'real'), join(dir, 'link'))
    expect(resolveCwdArg({ rootDir: join(dir, 'link') })).toBe(resolveCwdArg({ rootDir: join(dir, 'real') }))
    expect(resolveCwdArg({ cwd: join(dir, 'missing') })).toBe(join(dir, 'missing'))
  })

  it('should change the declaration cache key with the nearest lockfile', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'module/.nuxt'), { recursive: true })
    await writeFile(join(dir, 'module/.nuxt/tsconfig.json'), '{}')
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const before = await hashGeneratedTypes(join(dir, 'module'))
    expect(await hashGeneratedTypes(join(dir, 'module'))).toBe(before)
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n')
    expect(await hashGeneratedTypes(join(dir, 'module'))).not.toBe(before)
  })

  it('should refuse a bundled entry named `types`', () => {
    const cwd = join(repoRoot, 'example')
    for (const entries of [[{ input: './src/utils', name: 'types' }], ['./src/types']]) {
      expect(() => resolveModuleOptions(cwd, {}, join(cwd, 'dist'), { entries })).toThrow('named `types`, whose declarations would replace the generated `types.d.mts`')
    }
  })

  it('should find literal dynamic imports with comments, template literals and options', () => {
    const code = [
      `import(/* @vite-ignore */ './a')`,
      'import(`./b`)',
      `import('./c', { with: { type: 'json' } })`,
      'import(`./${name}`)',
    ].join('\n')
    expect(moduleSpecifiers(code).map(({ specifier }) => specifier)).toEqual(['./a', './b', './c'])
    expect([...valueSpecifiers(code)]).toEqual(['./a', './b', './c'])
  })

  it('should refuse an output directory outside the module', () => {
    for (const outDir of ['../sibling', '/elsewhere/dist', '.']) {
      expect(() => resolveOutDir('/repo/mod', outDir)).toThrow('which is not inside the module root')
    }
    expect(resolveOutDir('/repo/mod', '..dist')).toBe('/repo/mod/..dist')
  })

  it('should map a self-referencing subpath to the input of the entry with that name', () => {
    const pkg = { name: 'my-module', exports: { './vite': './dist/vite.mjs', './utils': './dist/utils.mjs' } }
    expect(selfReferencePaths('/mod', pkg, '/mod/dist', { module: './src/module.ts', vite: './src/lib/vite.ts' })).toEqual({
      'my-module': ['/mod/src/module'],
      'my-module/vite': ['/mod/src/lib/vite'],
      'my-module/utils': ['/mod/src/utils'],
    })
  })

  it('should treat a dot-prefixed name as a path inside the directory', () => {
    expect(relativeSpecifier('/mod/src/module.ts', '/mod/src/.generated/types.ts')).toBe('./.generated/types.ts')
    expect(relativeSpecifier('/mod/src/module.ts', '/mod/shared.ts')).toBe('../shared.ts')
  })

  it('should let the first config set every replace option', () => {
    const cwd = join(repoRoot, 'example')
    const translate = (...configs: unknown[]) => translateBuildConfig(configs.map((config, index) => ({ name: `config${index}`, config })), { cwd, outDir: join(cwd, 'dist') }).replace
    expect(translate(
      { rollup: { replace: { values: { A: 'a' }, preventAssignment: false, objectGuards: true } } },
      { rollup: { replace: { preventAssignment: true, objectGuards: false } } },
    )).toEqual({ values: { A: 'a' }, preventAssignment: false, objectGuards: true })
    expect(translate({ replace: { A: 'a' } })).toEqual({ values: { A: 'a' }, preventAssignment: true })
  })

  it('should only advise about `module.cjs` itself', () => {
    const warn = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    expect(checkLegacyCJSPaths(repoRoot, { main: './dist/submodule.cjs' })).toBe(false)
    expect(checkLegacyCJSPaths(repoRoot, { main: './dist/module.cjs' })).toBe(true)
    warn.mockRestore()
  })

  it('should not follow declaration files when deciding which JSX to compile', async () => {
    const cwd = await tempDir()
    await mkdir(join(cwd, 'src/runtime/server'), { recursive: true })
    await writeFile(join(cwd, 'src/module.ts'), 'export default {}\n')
    await writeFile(join(cwd, 'src/runtime/server/types.d.ts'), `export { default } from '../Button'\n`)
    await writeFile(join(cwd, 'src/runtime/server/handler.ts'), `export default 'handler'\n`)
    await writeFile(join(cwd, 'src/runtime/Button.tsx'), `export default () => <button />\n`)
    const plan = { cwd, entries: { module: './src/module.ts' }, directories: [{ srcDir: join(cwd, 'src/runtime'), outDir: join(cwd, 'dist/runtime'), ext: 'js' }] } as unknown as BuildPlan
    const { compiledJsx } = analyseSources(plan)
    expect([...compiledJsx].sort()).toEqual([join(cwd, 'src/module.ts'), join(cwd, 'src/runtime/server/handler.ts')])
  })
})

describe('regressions in a build', () => {
  const cli = (args: string[]) => exec('node', [join(repoRoot, 'src/cli.ts'), ...args], { nodeOptions: { cwd: repoRoot, env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' } } })

  afterAll(async () => {
    await rm(join(repoRoot, '.temp-regressions-symlink-link'), { force: true })
  })

  it('should keep runtime imports external and rewrite `#app` when built through a symlink', async () => {
    const dir = await copyExample('.temp-regressions-symlink', 'export default {\n  plugins: [builder()],\n}\n')
    const link = join(repoRoot, '.temp-regressions-symlink-link')
    await rm(link, { force: true })
    await symlink(dir, link)
    await writeFile(join(dir, 'src/runtime/helper.ts'), `export const helper: string = 'runtime helper'\n`)
    await appendFile(join(dir, 'src/module.ts'), `export { helper } from './runtime/helper.ts'\nexport function useApp(app: NuxtApp): NuxtApp {\n  return app\n}\n`)
    await writeFile(join(dir, 'src/module.ts'), `import type { NuxtApp } from '#app'\n${await readFile(join(dir, 'src/module.ts'), 'utf8')}`)

    const { exitCode } = await cli(['build', link])
    expect(exitCode).toBe(0)
    const code = await readFile(join(dir, 'dist/module.mjs'), 'utf8')
    expect(code).toContain(`from "./runtime/helper.js"`)
    expect(code).not.toContain('runtime helper')
    const declarations = await readFile(join(dir, 'dist/module.d.mts'), 'utf8')
    expect(declarations).toContain(`from "nuxt/app"`)
    expect(declarations).not.toContain('#app')
  })

  it('should fail and remove the output when the built module cannot be loaded', async () => {
    const dir = await copyExample('.temp-regressions-meta', 'export default {\n  plugins: [builder()],\n}\n')
    await appendFile(join(dir, 'src/module.ts'), `if (new URL(import.meta.url).pathname.endsWith('.mjs')) {\n  throw new Error('fails once built')\n}\n`)
    const { exitCode, stdout, stderr } = await cli(['build', dir])
    expect(exitCode).not.toBe(0)
    expect(stdout + stderr).toContain('Cannot load `dist/module.mjs` to write `module.json`: fails once built')
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })
})
