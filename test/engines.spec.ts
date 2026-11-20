import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'pathe'
import { beforeAll, describe, expect, it } from 'vitest'

import { createNativeEngine } from '../src/transpile/native.ts'
import type { NativeEngineName } from '../src/transpile/native.ts'
import type { Result } from './utils.ts'
import { bin, cli, exists, fixture, listFiles, read, repoRoot, run, tsdown, tsdownBin, waitFor, watch } from './utils.ts'

const NATIVE: NativeEngineName[] = ['typescript7', 'tsrs']
const store = (name: string) => `node_modules/.pnpm/${name}@1.0.0/node_modules/${name}`

/** Why `engine` cannot run here, if it cannot. */
async function unavailable(engine: NativeEngineName) {
  try {
    await (await createNativeEngine(repoRoot, engine)).close()
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const reasons = Object.fromEntries(await Promise.all(NATIVE.map(async engine => [engine, await unavailable(engine)] as const)))

const config = (engine: string, declarations = '') => `export default {\n  plugins: [builder({ entries: ['./src/utils', { input: './src/extra/', outDir: 'dist/extra' }], declarations: { engine: '${engine}'${declarations} } })],\n}\n`
const EXTRA = {
  'src/extra/index.ts': `import { twice } from './math.ts'\n\nexport const extra = { count: 1 as const, twice }\n`,
  'src/extra/math.ts': `export function twice(value: number) {\n  return value * 2\n}\n`,
}
const ISOLATED_MODULE = (source: string) => `import type { NuxtModule } from '@nuxt/schema'\n${source.replace('export default defineNuxtModule<ModuleOptions>({', 'const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({')}\nexport default module\n`
const UNANNOTATED = `const words = ['a', 'b']\n\nexport const myModuleUtils = (): void => {}\nexport const longest = words.reduce((a, b) => a.length > b.length ? a : b)\n`
const PORTABILITY = {
  [`${store('fake-logger')}/package.json`]: JSON.stringify({ name: 'fake-logger', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
  [`${store('fake-logger')}/index.d.ts`]: `export interface LoggerInstance { log: (message: string) => void }\nexport declare function createLogger(): LoggerInstance\n`,
  [`${store('fake-shared')}/package.json`]: JSON.stringify({ name: 'fake-shared', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
  [`${store('fake-shared')}/index.d.ts`]: `import { createLogger } from 'fake-logger'\nexport declare function createModuleLogger(name: string): ReturnType<typeof createLogger>\n`,
  [`${store('fake-shared')}/index.js`]: `export const createModuleLogger = () => ({ log() {} })\n`,
}
const PORTABILITY_LINKS = {
  'node_modules/.pnpm/fake-shared@1.0.0/node_modules/fake-logger': store('fake-logger'),
  'node_modules/fake-shared': store('fake-shared'),
}

const declarationsOf = async (dir: string, sub: string) => {
  const files = (await listFiles(join(dir, sub))).filter(file => /\.d\.[cm]?ts$/.test(file))
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await read(dir, sub, file)] as const)))
}

const dirs: Record<string, string> = {}
const results: Record<string, Result> = {}
const snapshots: Record<string, string> = {}
const step = async (name: string, result: Promise<Result>) => {
  results[name] = await result
  return results[name]
}
const expectBuilt = (name: string) => {
  expect(results[name]!.exitCode, results[name]!.output).toBe(0)
  return results[name]!.output
}
const expectFailed = (name: string) => {
  expect(results[name]!.exitCode, results[name]!.output).not.toBe(0)
  return results[name]!.output
}

beforeAll(async () => {
  for (const engine of ['typescript', ...NATIVE.filter(engine => !reasons[engine])]) {
    dirs[engine] = await fixture(`.temp-engines/${engine}`, { config: config(engine), files: EXTRA })
    dirs[`${engine}-portability`] = await fixture(`.temp-engines/${engine}-portability`, {
      config: config(engine),
      module: source => `export type Logger = typeof import('./logger.ts').logger\n${source}`,
      files: { ...PORTABILITY, 'src/logger.ts': `import { createModuleLogger } from 'fake-shared'\n\nexport const logger = createModuleLogger('my-module')\n` },
      links: PORTABILITY_LINKS,
    })
  }
  dirs.fallback = await fixture('.temp-engines/fallback', { config: config('tsrs'), files: EXTRA })
  dirs.isolated = await fixture('.temp-engines/isolated', {
    config: config('typescript', ', isolated: true'),
    module: ISOLATED_MODULE,
    files: { ...EXTRA, 'src/utils.ts': `export const myModuleUtils = (): void => {}\n` },
  })
  dirs.isolatedMissing = await fixture('.temp-engines/isolated-missing', {
    config: config('typescript', ', isolated: true'),
    module: ISOLATED_MODULE,
    files: { ...EXTRA, 'src/utils.ts': UNANNOTATED },
  })
  dirs.notIsolated = await fixture('.temp-engines/not-isolated', {
    config: config('typescript', ', isolated: false'),
    module: ISOLATED_MODULE,
    files: {
      ...EXTRA,
      'src/utils.ts': UNANNOTATED,
      'tsconfig.module.json': JSON.stringify({ extends: './.nuxt/tsconfig.node.json', compilerOptions: { isolatedDeclarations: true, declaration: true, allowJs: false } }),
      'tsconfig.json': source => JSON.stringify({ ...JSON.parse(source), references: [{ path: './tsconfig.module.json' }, ...JSON.parse(source).references.slice(1)] }),
    },
  })

  const native = NATIVE.filter(engine => !reasons[engine])
  await Promise.all([
    step('typescript', tsdown(dirs.typescript!)).then(() => step('typescript:prepare', cli(['prepare', dirs.typescript!]))),
    ...native.map(engine => step(engine, tsdown(dirs[engine]!)).then(() => step(`${engine}:prepare`, cli(['prepare', dirs[engine]!])))),
    ...['typescript', ...native].map(engine => step(`${engine}-portability`, tsdown(dirs[`${engine}-portability`]!)).then(() => step(`${engine}-portability:prepare`, cli(['prepare', dirs[`${engine}-portability`]!])))),
    step('fallback', tsdown(dirs.fallback!, [], { TSRS_BINARY: join(dirs.fallback!, 'missing-tsrs') })),
    step('isolated', tsdown(dirs.isolated!)).then(() => step('isolated:prepare', cli(['prepare', dirs.isolated!]))).then(() => step('isolated:typecheck', run(bin('vue-tsc'), ['-b', '--noEmit'], { cwd: dirs.isolated }))),
    step('isolatedMissing', tsdown(dirs.isolatedMissing!)).then(() => step('isolatedMissing:prepare', cli(['prepare', dirs.isolatedMissing!]))),
    step('notIsolated', tsdown(dirs.notIsolated!)).then(async () => {
      snapshots.notIsolated = await read(dirs.notIsolated!, 'dist/utils.d.mts').catch(() => '')
      await step('notIsolated:prepare', cli(['prepare', dirs.notIsolated!]))
      const file = join(dirs.notIsolated!, 'tsdown.config.ts')
      await writeFile(file, (await readFile(file, 'utf8')).replace('isolated: false', 'isolated: true'))
      await step('notIsolated:isolated', tsdown(dirs.notIsolated!))
      await writeFile(file, (await readFile(file, 'utf8')).replace(', isolated: true', ''))
      await step('notIsolated:tsconfig', tsdown(dirs.notIsolated!))
    }),
  ])
}, 600_000)

describe.each(NATIVE)('the %s declaration engine', (engine) => {
  const reason = reasons[engine]

  it.skipIf(reason)(`should generate the declarations TypeScript 6 generates for plain TypeScript, up to quote style${reason ? ` (skipped: ${reason})` : ''}`, async () => {
    expectBuilt(engine)
    expectBuilt(`${engine}:prepare`)
    expect(await declarationsOf(dirs[engine]!, 'dist')).toEqual(await declarationsOf(dirs.typescript!, 'dist'))
    expect(await declarationsOf(dirs[engine]!, 'dist')).toHaveProperty(['extra/math.d.mts'], expect.stringContaining('twice(value: number): number'))
    const withDoubleQuotes = (tree: Record<string, string>) => Object.fromEntries(Object.entries(tree).map(([file, text]) => [file, text.replaceAll('\'', '"')]))
    expect(withDoubleQuotes(await declarationsOf(dirs[engine]!, '.nuxt/module-builder/declarations'))).toEqual(withDoubleQuotes(await declarationsOf(dirs.typescript!, '.nuxt/module-builder/declarations')))
  })

  it.skipIf(reason)('should report an inferred type that cannot be named under its TypeScript 7 code, with the export to annotate', () => {
    const build = expectFailed(`${engine}-portability`)
    expect(build).toMatch(/src\/logger\.ts\(3,14\): error TS2883/)
    expect(build).toContain('- `logger` in src/logger.ts:3')
    expect(expectBuilt(`${engine}-portability:prepare`)).toMatch(/\[NUXT_MB_B0204\][\s\S]*src\/logger\.ts\(3,14\): error TS2883/)
  })

  it.skipIf(reason)('should update declarations from the same compiler process when a watched build rebuilds', async () => {
    const dir = dirs[engine]!
    const watcher = watch(dir, [tsdownBin, '--watch'])
    try {
      await waitFor(() => /Rebuilt in/.test(watcher.output()), 120_000)
      await writeFile(join(dir, 'src/extra/math.ts'), `export function twice(value: number) {\n  return value * 2\n}\n\nexport const half = (value: number) => value / 2\n`)
      await waitFor(async () => exists(dir, 'dist/extra/math.d.mts') && (await read(dir, 'dist/extra/math.d.mts')).includes('half'), 60_000)
      await writeFile(join(dir, 'src/utils.ts'), `export const myModuleUtils = () => {}\nexport const watched = 1 as const\n`)
      await waitFor(async () => (await read(dir, 'dist/utils.d.mts')).includes('watched: 1'), 60_000)
    }
    finally {
      await watcher.stop()
    }
  }, 240_000)
})

it.skipIf(reasons.tsrs?.includes('not installed'))('should generate declarations with the module\'s own TypeScript and warn once when the engine cannot run', async () => {
  const output = expectBuilt('fallback')
  expect(output.match(/NUXT_MB_C0404/g)).toHaveLength(1)
  expect(output).toContain('missing-tsrs')
  expect(await declarationsOf(dirs.fallback!, 'dist')).toEqual(await declarationsOf(dirs.typescript!, 'dist'))
})

it('should report an inferred type that cannot be named with TypeScript 6', () => {
  expect(expectFailed('typescript-portability')).toMatch(/src\/logger\.ts\(3,14\): error TS(2742|2883)/)
})

describe('`declarations.isolated`', () => {
  it('should build and prepare a module with annotated exports without the tsconfig setting, so the type check is unaffected', () => {
    expectBuilt('isolated')
    expectBuilt('isolated:prepare')
    expect(exists(dirs.isolated!, '.nuxt/module-builder/declarations/src/module.d.ts')).toBe(true)
    expectBuilt('isolated:typecheck')
  })

  it('should fail on an export without an explicit type, naming the file and the option', () => {
    const output = expectFailed('isolatedMissing')
    expect(output).toContain('NUXT_MB_B0202')
    expect(output).toContain('src/utils.ts')
    expect(output).toMatch(/TS90\d\d/)
    expect(output).toContain('`declarations.isolated` selects')
    expect(expectBuilt('isolatedMissing:prepare')).toMatch(/\[NUXT_MB_B0204\][\s\S]*src\/utils\.ts/)
  })

  it('should generate declarations with the engine when `false`, whatever the tsconfig sets, and not reuse them once `true`', async () => {
    expectBuilt('notIsolated')
    expect(snapshots.notIsolated).toContain('longest: string')
    expect(expectBuilt('notIsolated:prepare')).not.toContain('NUXT_MB_B0204')
    expect(expectFailed('notIsolated:isolated')).toContain('`declarations.isolated` selects')
    expect(expectFailed('notIsolated:tsconfig')).toContain('the tsconfig\'s `isolatedDeclarations` selects')
  })
})
