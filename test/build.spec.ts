import { fileURLToPath } from 'url'
import { readFile, readdir } from 'fs/promises'
import { beforeAll, describe, it, expect } from 'vitest'
import { execaCommand } from 'execa'
import { join } from 'pathe'

describe('module builder', () => {
  const rootDir = fileURLToPath(new URL('../example', import.meta.url))
  const distDir = join(rootDir, 'dist')
  const runtimeDir = join(distDir, 'runtime')

  beforeAll(async () => {
    await execaCommand('pnpm dev:prepare', { cwd: rootDir })
    await execaCommand('pnpm prepack', { cwd: rootDir })
  }, 120 * 1000)

  it('should generate all files', async () => {
    const files = await readdir(distDir)
    expect(files).toMatchInlineSnapshot(`
      [
        "module.cjs",
        "module.d.ts",
        "module.json",
        "module.mjs",
        "runtime",
        "types.d.ts",
        "utils.d.ts",
        "utils.mjs",
      ]
    `)

    const runtime = await readdir(runtimeDir)
    expect(runtime).toMatchInlineSnapshot(`
      [
        "plugin.d.ts",
        "plugin.mjs",
      ]
    `)
  })

  it.todo('should generate typed plugin', async () => {
    const pluginDts = await readFile(join(distDir, 'runtime/plugin.d.ts'), 'utf-8')
    expect(pluginDts).toMatchInlineSnapshot(`
      "declare const _default: any;
      export default _default;
      "
    `)
  })
})
