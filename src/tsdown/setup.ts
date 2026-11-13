import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'pathe'
import { consola } from 'consola'
import { readPackageJSON } from 'pkg-types'
import type { InlineConfig, ResolvedConfig, Rolldown, UserConfig } from 'tsdown'

import { finishBuild, onBuildError, prepareBuild, preservesJsx, resolveBuild, resolveDirectoryExternal } from '../build/build.ts'
import type { BuildPlan } from '../build/build.ts'
import { assertNoLegacyBuildConfig, loadBuildConfig, resolveModuleOptions, resolveOutDir } from '../build/build-config.ts'
import type { BuilderOptions } from '../build/build-config.ts'
import { guide } from '../build/guide.ts'
import { loadOxc } from '../build/loader.ts'
import { prepareModule } from '../commands/prepare.ts'
import { transpileDir, TYPE_ERRORS_WARNING } from '../rolldown/transpile-dir.ts'
import { externalDependencyDeclarations } from './externals.ts'
import { replacePlugin } from './replace.ts'
import { runtimeExternals } from './runtime-externals.ts'

export interface SetupOptions {
  /** Read `build.config.*` and `package.json`'s `build` or `unbuild` field. */
  legacy: boolean
}

export interface BuilderSession {
  plan: BuildPlan
  /** Whether a build has started with this session. */
  started: boolean
  /** Directories a watcher watches as a whole, so new files in them trigger a rebuild. */
  watchDirs: string[]
  /** Fails when the resolved config no longer matches what `builder()` set. */
  checkResolved: (resolved: ResolvedConfig) => void
  onBuildEnd: (error?: Error) => Promise<void>
  onWriteBundle: () => Promise<void>
}

const ESM_FORMATS = new Set(['es', 'esm', 'module'])

const FORBIDDEN: Array<[option: string, isSet: (config: UserConfig) => boolean, reason: string]> = [
  ['entry', config => config.entry !== undefined, 'list bundled entries besides `src/module` in `builder({ entries })`'],
  ['format', config => config.format !== undefined && !(typeof config.format === 'string' ? [config.format] : Array.isArray(config.format) ? config.format : ['object']).every(format => ESM_FORMATS.has(format)), 'modules are built as ES modules only'],
  ['dts', config => config.dts !== undefined && config.dts !== true, 'declarations are generated with the module\'s own tsconfig'],
  ['clean', config => config.clean !== undefined, 'the output directory is always emptied before the build'],
  ['unbundle', config => !!config.unbundle, 'the module entry is bundled, and runtime directories are transpiled file by file'],
  ['exports', config => !!config.exports, 'the exports tsdown generates leave out `types.d.mts` and the runtime directories'],
  ['fixedExtension', config => config.fixedExtension === false, 'the module entry is emitted as `module.mjs`'],
  ['outExtensions', config => config.outExtensions !== undefined, 'the module entry is emitted as `module.mjs`'],
  ['platform', config => config.platform !== undefined && config.platform !== 'node', 'Nuxt modules run in Node'],
  ['workspace', config => config.workspace !== undefined, 'give each module a tsdown config of its own'],
  ['external', config => config.external !== undefined, 'use `builder({ externals })` or `deps.neverBundle`'],
  ['noExternal', config => config.noExternal !== undefined, 'use `deps.alwaysBundle`'],
  ['deps.neverBundle', config => config.deps?.neverBundle === true || typeof config.deps?.neverBundle === 'function', 'list the imports that are never bundled'],
]

/**
 * Resolves the module build for `config`, fills in the tsdown options it depends on and
 * adds the plugins and hooks that build the module.
 */
export async function setupBuilder(config: UserConfig, inline: InlineConfig, options: BuilderOptions, { legacy }: SetupOptions): Promise<BuilderSession> {
  const forbidden = FORBIDDEN.filter(([, isSet]) => isSet(config))
  if (forbidden.length) {
    throw new Error([
      '`builder()` sets these tsdown options itself, so the tsdown config must leave them out:',
      ...forbidden.map(([option, , reason]) => `  - \`${option}\`: ${reason}`),
      guide('options-builder-sets'),
    ].join('\n'))
  }

  const cwd = resolve(config.cwd ?? process.cwd())
  const pkg = await readPackageJSON(cwd)
  const outDirOption = config.outDir ?? 'dist'
  const outDir = resolveOutDir(cwd, outDirOption, inline.outDir === undefined && config.outDir !== undefined ? `outDir: '${outDirOption}'` : `--outDir ${outDirOption}`)
  if (!legacy) {
    assertNoLegacyBuildConfig(cwd, pkg)
  }
  const buildConfig = legacy ? await loadBuildConfig(cwd, pkg, outDir) : resolveModuleOptions(cwd, pkg, outDir, options)

  if (!existsSync(resolve(cwd, '.nuxt/tsconfig.json'))) {
    consola.info(`\`.nuxt\` not found, running \`nuxt-module-build prepare\` first. Add it to the module's \`dev:prepare\` script to skip this step. ${guide('preparing-nuxt')}`)
    await prepareModule(cwd, buildConfig)
  }

  const plan = await resolveBuild({ cwd, pkg, outDir, sourcemap: !!config.sourcemap, loadConfig: async () => buildConfig })
  const directoryPlugins = plan.directories.map(directory => transpileDir({
    cwd,
    srcDir: directory.srcDir,
    outBase: relative(outDir, directory.outDir),
    extension: directory.ext,
    paths: plan.directoryPaths,
    transform: loadOxc()?.transform,
    sourcemap: plan.sourcemap,
    vue: { cacheVersion: plan.generatedTypesHash },
    jsx: file => preservesJsx(plan, file) ? 'preserve' : { runtime: 'automatic', importSource: 'vue' },
    resolveExternal: resolveDirectoryExternal(plan, directory),
  }))

  let watch = false
  let failed = false
  const fail = async (error: unknown, directory?: boolean) => {
    if (!failed) {
      failed = true
      await onBuildError(plan, error, { directory, keepOutput: watch })
    }
  }
  for (const plugin of directoryPlugins) {
    const generateBundle = plugin.generateBundle as (this: Rolldown.PluginContext, ...args: unknown[]) => Promise<void>
    plugin.generateBundle = async function (...args: unknown[]) {
      try {
        return await generateBundle.apply(this, args)
      }
      catch (error) {
        await fail(error, true)
        throw error
      }
    }
  }

  const userNeverBundle = config.deps?.neverBundle as Array<string | RegExp> | string | RegExp | undefined
  const userInputOptions = config.inputOptions
  const userHooks = config.hooks
  const dts = {
    tsconfig: plan.declarationTsconfig,
    generator: plan.isolatedDeclarations ? 'oxc' : 'tsc',
    tsc: { eager: true, parallel: true },
    compilerOptions: { paths: plan.declarationPaths },
  } as const

  Object.assign(config, {
    entry: plan.entries,
    format: 'esm',
    outDir,
    clean: false,
    report: config.report ?? false,
    sourcemap: config.sourcemap || plan.sourcemap,
    deps: { ...config.deps, neverBundle: [...plan.neverBundle, ...userNeverBundle === undefined ? [] : [userNeverBundle].flat()] },
    dts,
    inputOptions: async (inputOptions, format, context) => {
      const options = typeof userInputOptions === 'function' ? await userInputOptions(inputOptions, format, context) ?? inputOptions : { ...inputOptions, ...userInputOptions }
      return {
        ...options,
        makeAbsoluteExternalsRelative: false,
        onLog(level, log, handler) {
          const linked = log.pluginCode === TYPE_ERRORS_WARNING ? { ...log, message: `${log.message}\n${guide('other-type-errors')}` } : log
          return options.onLog ? options.onLog(level, linked, handler) : handler(level, linked)
        },
      }
    },
    hooks: async (hooks) => {
      if (typeof userHooks === 'function') {
        await userHooks(hooks)
      }
      else if (userHooks) {
        hooks.addHooks(userHooks)
      }
      hooks.hook('build:prepare', async () => {
        session.started = true
        await prepareBuild(plan)
      })
    },
    plugins: [
      config.plugins,
      externalDependencyDeclarations(),
      runtimeExternals({ outDir, directories: plan.directories, packageName: pkg.name, preserveJsx: file => preservesJsx(plan, file) }),
      ...plan.config.replace ? [await replacePlugin(plan.config.replace)] : [],
      ...directoryPlugins,
    ],
  } satisfies UserConfig)

  const session: BuilderSession = {
    plan,
    started: false,
    watchDirs: [...new Set(plan.runtimeDirs.map(dir => existingAncestor(dir, cwd)))],
    checkResolved(resolved) {
      watch = !!resolved.watch
      const changed = [
        ...resolved.format !== 'es' ? ['format'] : [],
        ...Object.keys(resolved.entry).length !== Object.keys(plan.entries).length || Object.entries(plan.entries).some(([name, input]) => !resolved.entry[name] || resolve(cwd, resolved.entry[name]) !== resolve(cwd, input)) ? ['entry'] : [],
        ...resolved.outDir !== outDir ? ['outDir'] : [],
        ...!resolved.dts || resolved.dts.tsconfig !== dts.tsconfig ? ['dts'] : [],
        ...resolved.clean.length ? ['clean'] : [],
        ...resolved.unbundle ? ['unbundle'] : [],
        ...resolved.exports ? ['exports'] : [],
        ...resolved.platform !== 'node' ? ['platform'] : [],
        ...!resolved.fixedExtension || resolved.outExtensions ? ['fixedExtension'] : [],
      ]
      if (changed.length) {
        throw new Error(`Another tsdown plugin changed ${changed.map(option => `\`${option}\``).join(', ')}, which \`builder()\` sets. ${guide('options-builder-sets')}`)
      }
    },
    async onBuildEnd(error) {
      if (error) {
        await fail(error)
      }
      else {
        failed = false
      }
    },
    async onWriteBundle() {
      const outputs = await Promise.all(directoryPlugins.map(plugin => plugin.api.outputs))
      await finishBuild(plan, {
        outputs: outputs.flatMap(map => [...map.values()]),
        builder: { tsdown: await readPackageJSON('tsdown', { from: import.meta.url }).then(r => r.version || 'unknown').catch(() => 'unknown') },
      })
    },
  }
  return session
}

/** `dir`, or the closest directory above it that exists, so a watcher sees `dir` being created. */
function existingAncestor(dir: string, root: string) {
  while (!existsSync(dir) && dir !== root && dirname(dir) !== dir) {
    dir = dirname(dir)
  }
  return dir
}
