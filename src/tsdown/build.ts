import { relative } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import { build as tsdownBuild } from 'tsdown'
import type { InlineConfig } from 'tsdown'

import { transpileDir, TYPE_ERRORS_WARNING } from '../rolldown/transpile-dir.ts'
import { finishBuild, onBuildError, prepareBuild, preservesJsx, resolveBuild, resolveDirectoryExternal } from '../build/build.ts'
import type { BuildPlan } from '../build/build.ts'
import { loadBuildConfig, resolveOutDir } from '../build/build-config.ts'
import { guide } from '../build/guide.ts'
import { loadOxc } from '../build/loader.ts'
import { externalDependencyDeclarations } from './externals.ts'
import { replacePlugin } from './replace.ts'
import { runtimeExternals } from './runtime-externals.ts'

export interface BuildOptions {
  outDir: string
  sourcemap: boolean
}

export async function build(cwd: string, options: BuildOptions): Promise<void> {
  const pkg = await readPackageJSON(cwd)
  const outDir = resolveOutDir(cwd, options.outDir)
  const plan = await resolveBuild({ cwd, pkg, outDir, sourcemap: options.sourcemap, loadConfig: () => loadBuildConfig(cwd, pkg, outDir) })
  const prepared = await prepareBuild(plan)

  const directoryPlugins = transpileDirPlugins(plan)
  await tsdownBuild({
    cwd,
    config: false,
    format: 'esm',
    outDir,
    clean: false,
    report: false,
    sourcemap: plan.sourcemap,
    deps: { neverBundle: plan.neverBundle },
    entry: plan.entries,
    dts: {
      tsconfig: prepared.declarationTsconfig,
      generator: plan.isolatedDeclarations ? 'oxc' : 'tsc',
      tsc: { eager: true, parallel: true },
      compilerOptions: { paths: plan.declarationPaths },
    },
    inputOptions: options => ({
      ...options,
      makeAbsoluteExternalsRelative: false,
      onLog(level, log, handler) {
        const linked = log.pluginCode === TYPE_ERRORS_WARNING ? { ...log, message: `${log.message}\n${guide('other-type-errors')}` } : log
        return options.onLog ? options.onLog(level, linked, handler) : handler(level, linked)
      },
    }),
    plugins: [
      externalDependencyDeclarations(),
      runtimeExternals({ outDir, directories: plan.directories, packageName: pkg.name, preserveJsx: file => preservesJsx(plan, file) }),
      ...plan.config.replace ? [await replacePlugin(plan.config.replace)] : [],
      ...directoryPlugins,
    ],
  } satisfies InlineConfig).catch(async (error) => {
    await onBuildError(plan, error)
    throw error
  })

  const outputs = await Promise.all(directoryPlugins.map(plugin => plugin.api.outputs))
  await finishBuild(plan, {
    outputs: outputs.flatMap(map => [...map.values()]),
    builder: { tsdown: await readPackageJSON('tsdown', { from: import.meta.url }).then(r => r.version || 'unknown').catch(() => 'unknown') },
  })
}

function transpileDirPlugins(plan: BuildPlan) {
  return plan.directories.map(directory => transpileDir({
    cwd: plan.cwd,
    srcDir: directory.srcDir,
    outBase: relative(plan.outDir, directory.outDir),
    extension: directory.ext,
    paths: plan.directoryPaths,
    transform: loadOxc()?.transform,
    sourcemap: plan.sourcemap,
    vue: { cacheVersion: plan.generatedTypesHash },
    jsx: file => preservesJsx(plan, file) ? 'preserve' : { runtime: 'automatic', importSource: 'vue' },
    resolveExternal: resolveDirectoryExternal(plan, directory),
  }))
}
