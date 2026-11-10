import { relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'

import { probe } from './loader.ts'

/**
 * The files bundled on their own, by output name: `src/module` plus any `build.entries`
 * of `package.json`, which unbuild read and named after their path under `src/`.
 */
export function bundledEntries(cwd: string, pkg: PackageJson) {
  const entries: Record<string, string> = {}
  for (const entry of (pkg as { build?: { entries?: string[] } }).build?.entries ?? []) {
    const input = probe(resolve(cwd, entry))
    if (input) {
      entries[entryName(input, cwd)] = `./${relative(cwd, input)}`
    }
  }
  const module = probe(resolve(cwd, 'src/module')) ?? resolve(cwd, 'src/module.ts')
  return { ...entries, module: `./${relative(cwd, module)}` }
}

function entryName(input: string, cwd: string) {
  return relative(cwd, input).replace(/^src\//, '').replace(/\.(?:js|mjs|cjs|ts|mts|cts|json|jsx|tsx)$/, '')
}
