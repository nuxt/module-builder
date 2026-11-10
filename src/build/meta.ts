import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import { resolve } from 'pathe'
import type { NuxtModule } from '@nuxt/schema'

export interface WriteModuleMetaOptions {
  cwd: string
  outDir: string
  pkg: { name?: string, version?: string }
  builder: Record<string, string>
}

export async function writeModuleMeta({ cwd, outDir, pkg, builder }: WriteModuleMetaOptions) {
  const jiti = createJiti(cwd)
  const moduleFn = await jiti.import<NuxtModule<Record<string, unknown>>>(pathToFileURL(resolve(outDir, 'module.mjs')).href, { default: true })

  const moduleMeta = await moduleFn.getMeta?.() || {}
  moduleMeta.name ||= pkg.name
  moduleMeta.version ||= pkg.version
  moduleMeta.builder = builder

  await writeFile(resolve(outDir, 'module.json'), JSON.stringify(moduleMeta, null, 2), 'utf8')
}
