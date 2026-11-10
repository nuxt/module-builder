import { writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import type { NuxtModule } from '@nuxt/schema'

import { importModule } from './loader.ts'

export interface WriteModuleMetaOptions {
  cwd: string
  outDir: string
  pkg: { name?: string, version?: string }
  builder: Record<string, string>
}

export async function writeModuleMeta({ cwd, outDir, pkg, builder }: WriteModuleMetaOptions) {
  const moduleExports = await importModule(resolve(outDir, 'module.mjs'), { cwd })
  const moduleFn = (moduleExports.default ?? moduleExports) as NuxtModule<Record<string, unknown>>

  const moduleMeta = await moduleFn.getMeta?.() || {}
  moduleMeta.name ||= pkg.name
  moduleMeta.version ||= pkg.version
  moduleMeta.builder = builder

  await writeFile(resolve(outDir, 'module.json'), JSON.stringify(moduleMeta, null, 2), 'utf8')
}
