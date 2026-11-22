import { createFilesMatcher } from 'get-tsconfig'
import { dirname, join, relative, resolve } from 'pathe'
import { glob } from 'tinyglobby'

import { warnings } from '../diagnostics.ts'
import type { TsconfigResolver } from '../transpile/tsconfig.ts'
import { loadTypescript } from '../transpile/typescript.ts'
import { moduleTsconfigs } from './build.ts'

const NUXT_BUILD_DIR_RE = /[\\/]\.nuxt(?:[\\/]|$)/
const FOREIGN_DIRS = ['src', 'playground*', 'docs', 'example', 'examples']

let noted = false

export interface UncheckedFilesOptions {
  outDir: string
  /** The root tsconfig's `exclude`, as absolute patterns. */
  exclude: string[]
}

/**
 * The module's TypeScript files that no project the root tsconfig references includes or
 * excludes, grouped by their first directory, or by file at the module root. Declarations and
 * files in `src`, which the parts include or module code imports, are left out, and so are files
 * in the output directory, in `node_modules`, in the playground, docs and example directories,
 * and in the root's `exclude`.
 */
async function uncheckedFiles(cwd: string, tsconfigs: TsconfigResolver, { outDir, exclude }: UncheckedFilesOptions): Promise<Map<string, number>> {
  const { root } = tsconfigs
  const groups = new Map<string, number>()
  if (!root?.config.references?.length || tsconfigs.replaced) {
    return groups
  }
  const { ts } = loadTypescript()
  const ownExcludes = root.config.references.flatMap(({ path }) => {
    const file = resolve(dirname(root.path), path)
    const config = file.endsWith('.json') ? file : join(file, 'tsconfig.json')
    if (NUXT_BUILD_DIR_RE.test(config)) {
      return []
    }
    const patterns = (ts.readConfigFile(config, ts.sys.readFile).config as { exclude?: unknown } | undefined)?.exclude
    return Array.isArray(patterns) ? patterns.filter(pattern => typeof pattern === 'string').map(pattern => resolve(dirname(config), pattern)) : []
  })
  const ignore = [outDir, ...exclude, ...ownExcludes].flatMap((pattern) => {
    const path = relative(cwd, pattern)
    return [path, `${path}/**`]
  })
  const files = await glob(['**/*.{ts,tsx,mts,cts,vue}'], {
    cwd,
    absolute: true,
    ignore: [...ignore, ...FOREIGN_DIRS.map(dir => `${dir}/**`), '**/node_modules/**', '**/*.d.{ts,mts,cts}'],
  })
  const inRoot = createFilesMatcher(root)
  for (const file of files.sort()) {
    if (tsconfigs.resolve(file) !== root || inRoot(file.endsWith('.vue') ? `${file}.ts` : file)) {
      continue
    }
    const [first, ...rest] = relative(cwd, file).split('/')
    const group = rest.length ? `${first}/` : first!
    groups.set(group, (groups.get(group) ?? 0) + 1)
  }
  return groups
}

/** Prints {@link uncheckedFiles} once per process, outside CI. */
export async function noteUncheckedFiles(cwd: string, options: UncheckedFilesOptions): Promise<void> {
  if (noted || process.env.CI) {
    return
  }
  const groups = await uncheckedFiles(cwd, await moduleTsconfigs(cwd), options)
  if (groups.size) {
    noted = true
    const named = ['tsconfig.json', 'tsconfig.test.json', ...groups.keys()]
    warnings.NUXT_MB_C0303({ groups: [...groups], sources: named.map(path => `${resolve(cwd, path)}${path.endsWith('/') ? '/' : ''}`) }, { method: 'info' })
  }
}
