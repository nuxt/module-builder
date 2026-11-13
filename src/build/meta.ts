import { writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import type { NuxtModule } from '@nuxt/schema'

import { importModule } from './loader.ts'

export interface WriteModuleMetaOptions {
  cwd: string
  outDir: string
  /** Directories whose files import relative sources without extensions. */
  runtimeDirs: string[]
  pkg: { name?: string, version?: string }
  builder: Record<string, string>
  /** Set on rebuilds, so the rebuilt module is imported rather than the cached one. */
  version?: number
}

export async function writeModuleMeta({ cwd, outDir, runtimeDirs, pkg, builder, version }: WriteModuleMetaOptions): Promise<void> {
  const moduleExports = await importModule(resolve(outDir, 'module.mjs'), { cwd, runtimeDirs, version })
  const moduleFn = (moduleExports.default ?? moduleExports) as NuxtModule<Record<string, unknown>>

  const moduleMeta = await moduleFn.getMeta?.() || {}
  moduleMeta.name ||= pkg.name
  moduleMeta.version ||= pkg.version
  moduleMeta.builder = builder

  await writeFile(resolve(outDir, 'module.json'), JSON.stringify(moduleMeta, null, 2), 'utf8')
}
