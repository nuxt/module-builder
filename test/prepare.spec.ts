import { fileURLToPath } from 'node:url'
import { cp, mkdir, rm } from 'node:fs/promises'
import ts from 'typescript'
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

  it('includes runtime server plugin in resolved tsconfig files', async () => {
    const serverTsconfigPath = join(prepareRootDir, '.nuxt/tsconfig.server.json')
    const sourceFile = ts.readJsonConfigFile(serverTsconfigPath, ts.sys.readFile)
    const parsed = ts.parseJsonSourceFileConfigFileContent(sourceFile, ts.sys, dirname(serverTsconfigPath))
    const expectedPluginPath = join(prepareRootDir, 'src/runtime/server/plugins/plugin.ts')
    expect(parsed.fileNames).toContain(expectedPluginPath)
  })
})
