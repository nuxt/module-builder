import { fileURLToPath } from 'node:url'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { exec } from 'tinyexec'
import { dirname, join } from 'pathe'

describe('module builder', () => {
  const workspaceDir = fileURLToPath(new URL('..', import.meta.url))
  const exampleDir = fileURLToPath(new URL('../example', import.meta.url))
  const prepareRootDir = exampleDir.replace('example', '.temp-example-prepare')

  beforeAll(async () => {
    await mkdir(dirname(prepareRootDir), { recursive: true })
    await rm(prepareRootDir, { force: true, recursive: true })
    await cp(exampleDir, prepareRootDir, { recursive: true })

    await exec('pnpm', ['nuxt-module-build', 'prepare', prepareRootDir], {
    nodeOptions: { cwd: workspaceDir },
    })
  }, 120 * 1000)

  it('includes module runtime in generated server tsconfig', async () => {
    const serverTsconfig = await readFile(join(prepareRootDir, '.nuxt/tsconfig.server.json'), 'utf-8')
    const parsed = JSON.parse(serverTsconfig) as { include?: unknown }
    const include = Array.isArray(parsed.include) ? parsed.include : []

    expect(
    include.some(
        value => typeof value === 'string' && value.includes('../src/runtime'),
    ),
    ).toBe(true)
  })
})
