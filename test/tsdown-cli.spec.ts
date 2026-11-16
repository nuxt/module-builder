import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'pathe'
import { exec } from 'tinyexec'
import { describe, expect, it } from 'vitest'

import { guide } from '../src/build/guide.ts'
import { builderImport, copyExample, repoRoot } from './utils.ts'

describe('builder', () => {
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
})
