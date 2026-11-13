import { promises as fsp } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'pathe'
import { consola } from 'consola'
import { findExports } from 'mlly'
import { readPackageJSON } from 'pkg-types'

import builderPkg from '../../package.json' with { type: 'json' }
import { assertNoLegacyBuildConfig, bundledEntries, callBuildHook, createBuildContext, formatUnsupportedOptions, loadBuildConfig, resolveModuleOptions, resolveOutDir, warnDeprecatedBuildConfig } from './build-config.ts'
import type { BuilderOptions } from './build-config.ts'
import { checkDeprecatedPackageFields } from './deprecations.ts'
import { guide } from './guide.ts'
import { assertResolvableImports, findNonErasableSyntax, listNonErasableSyntax } from './loader.ts'
import type { NonErasableSyntax } from './loader.ts'
import { writeModuleMeta } from './meta.ts'
import { writeTypes } from './types.ts'

export interface StubOptions {
  outDir: string
  /** Whether `outDir` comes from the tsdown config rather than `--outDir`. */
  outDirFromConfig?: boolean
  /** The options of `builder()` in the tsdown config, which replace `build.config.*` and `package.json`'s `build` field. */
  moduleOptions?: BuilderOptions
}

export function erasableSyntaxHint(found: NonErasableSyntax[]): string {
  return [
    'Node cannot run this module\'s source directly.',
    'Without `tsdown` installed, `nuxt-module-build build --stub` relies on Node\'s built-in type stripping, which only erases types: `enum`, `namespace`, parameter properties, `<T>value` assertions and legacy decorators are not supported.',
    ...found.length ? ['These files use such syntax:', ...listNonErasableSyntax(found)] : [],
    `Install \`tsdown\`, or set \`erasableSyntaxOnly: true\` in your \`tsconfig.json\` and replace the syntax listed. ${guide('stub-builds')}`,
  ].join('\n')
}

/**
 * Write plain re-export files pointing back at the module's TypeScript sources.
 * Node's type stripping loads them directly, so no bundler is involved.
 */
export async function stub(cwd: string, options: StubOptions): Promise<void> {
  const pkg = await readPackageJSON(cwd)
  const outDir = resolveOutDir(cwd, options.outDir, options.outDirFromConfig ? `outDir: '${options.outDir}'` : undefined)

  if (options.moduleOptions) {
    assertNoLegacyBuildConfig(cwd, pkg)
  }
  const config = options.moduleOptions ? resolveModuleOptions(cwd, pkg, outDir, options.moduleOptions) : await loadBuildConfig(cwd, pkg, outDir)
  // The stub only re-exports sources, so options the full build rejects do not affect it.
  if (config.unsupported.length) {
    consola.warn(formatUnsupportedOptions(config.unsupported))
  }
  warnDeprecatedBuildConfig(config)

  const directories = [{ srcDir: resolve(cwd, 'src/runtime'), outDir: resolve(outDir, 'runtime'), ext: 'js' as const }, ...config.directories]
  const entries = bundledEntries(cwd, config)
  const runtimeDirs = directories.map(directory => directory.srcDir)
  const ctx = createBuildContext({ cwd, outDir, pkg, config, directories, stub: true, sourcemap: false })
  await callBuildHook(config, 'build:before', ctx)
  assertResolvableImports(cwd, Object.values(entries), runtimeDirs)

  await rm(outDir, { recursive: true, force: true })
  await fsp.mkdir(outDir, { recursive: true })

  for (const [name, input] of Object.entries(entries)) {
    const entry = resolve(cwd, input)
    const source = await fsp.readFile(entry, 'utf8')
    const hasDefaultExport = findExports(source).some(e => e.type === 'default' || e.names?.includes('default'))

    await fsp.mkdir(dirname(resolve(outDir, name)), { recursive: true })
    const specifier = relative(dirname(resolve(outDir, name)), entry)
    const reExports = [
      `export * from '${specifier}'`,
      ...hasDefaultExport ? [`export { default } from '${specifier}'`] : [],
    ].join('\n') + '\n'

    await fsp.writeFile(resolve(outDir, `${name}.mjs`), reExports, 'utf8')
    // TypeScript resolves the `.js` specifier back to the `.ts` source without
    // requiring consumers to enable `allowImportingTsExtensions`.
    await fsp.writeFile(resolve(outDir, `${name}.d.mts`), reExports.replace(/\.([cm]?)tsx?'/g, '.$1js\''), 'utf8')
  }

  await writeModuleMeta({ cwd, outDir, runtimeDirs, pkg, builder: { [builderPkg.name]: builderPkg.version } }).catch((error: Error & { code?: string }) => {
    if (error.code?.startsWith('ERR_UNSUPPORTED_') || error.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX') {
      consola.error(erasableSyntaxHint(findNonErasableSyntax(cwd, Object.values(entries))))
    }
    throw error
  })
  await writeTypes(outDir, true)
  await callBuildHook(config, 'rollup:done', ctx)
  await checkDeprecatedPackageFields(cwd, { stub: true })
  await callBuildHook(config, 'build:done', ctx)
}
