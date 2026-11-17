import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { relative, resolve } from 'pathe'
import { resolvePath } from 'mlly'
import { readPackageJSON } from 'pkg-types'
import type { PackageJson } from 'pkg-types'
import type { InlineConfig, ResolvedConfig, Rolldown, UserConfig } from 'tsdown'

import { analyseSources, finishBuild, onBuildError, prepareBuild, preservesJsx, resolveBuild, resolveDirectoryExternal } from '../build/build.ts'
import { guide } from '../build/guide.ts'
import { loadOxc } from '../build/loader.ts'
import { resolveModuleOptions, resolveOutDir } from '../build/options.ts'
import type { BuilderOptions, ModuleConfig, ReplaceOptions } from '../build/options.ts'
import { sourcePathsPackError, unpublishablePathsError } from '../build/package.ts'
import { prepareModule } from '../commands/prepare.ts'
import { transpileDir, TYPE_ERRORS_WARNING } from '../transpile/transpile-dir.ts'
import { findUp, logger, realpath } from '../utils.ts'
import { externalDependencyDeclarations, runtimeExternals } from './externals.ts'
import { defaultReport, reportsSummary, sizeBreakdown } from './report.ts'
import { unchangedOutputs } from './unchanged.ts'

export interface SetupOptions {
  /** Loads the module's options from elsewhere than `builder()`. */
  loadConfig?: (cwd: string, pkg: PackageJson, outDir: string) => Promise<ModuleConfig>
}

export interface BuilderSession {
  /** Whether a build has started with this session. */
  started: boolean
  /** Directories a watcher watches as a whole, so new files in them trigger a rebuild. */
  watchDirs: string[]
  /** Fails when the resolved config no longer matches what `builder()` set. */
  checkResolved: (resolved: ResolvedConfig) => void
  /** Refreshes the source analysis for a rebuild, before the directory plugins start. */
  onBuildStart: () => void
  onBuildEnd: (error?: Error) => Promise<void>
  /**
   * Fails when the bundled entries are not emitted at the file names `builder()` sets, and
   * leaves out the outputs a watched rebuild emits unchanged, so they are not written again.
   */
  onGenerateBundle: (bundle: Rolldown.OutputBundle) => Promise<void>
  onWriteBundle: () => Promise<void>
}

const ESM_FORMATS = new Set(['es', 'esm', 'module'])

const FORBIDDEN: Array<[option: string, isSet: (config: UserConfig) => boolean, reason: string]> = [
  ['entry', config => config.entry !== undefined, 'list bundled entries besides `src/module` in `builder({ entries })`'],
  ['format', config => config.format !== undefined && !(typeof config.format === 'string' ? [config.format] : Array.isArray(config.format) ? config.format : ['object']).every(format => ESM_FORMATS.has(format)), 'modules are built as ES modules only'],
  ['dts', config => config.dts !== undefined && config.dts !== true, 'declarations are generated with the module\'s own tsconfig'],
  ['clean', config => config.clean !== undefined, 'the output directory is emptied before a one-off build, and a watched build removes the files it no longer emits'],
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
export async function setupBuilder(config: UserConfig, inline: InlineConfig, options: BuilderOptions, { loadConfig }: SetupOptions): Promise<BuilderSession> {
  const forbidden = FORBIDDEN.filter(([, isSet]) => isSet(config))
  if (forbidden.length) {
    throw new Error([
      '`builder()` sets these tsdown options itself, so the tsdown config must leave them out:',
      ...forbidden.map(([option, , reason]) => `  - \`${option}\`: ${reason}`),
      guide('options-builder-sets'),
    ].join('\n'))
  }

  const cwd = realpath(config.cwd ?? process.cwd())
  const pkg = await readPackageJSON(cwd)
  const packageError = sourcePathsPackError(cwd, pkg) ?? unpublishablePathsError(cwd, pkg)
  if (packageError) {
    throw new Error(packageError)
  }
  const outDirOption = config.outDir ?? 'dist'
  const outDir = resolveOutDir(cwd, outDirOption, inline.outDir === undefined && config.outDir !== undefined ? `outDir: '${outDirOption}'` : `--outDir ${outDirOption}`)
  const buildConfig = loadConfig ? await loadConfig(cwd, pkg, outDir) : resolveModuleOptions(cwd, pkg, outDir, options)

  if (!existsSync(resolve(cwd, '.nuxt/tsconfig.json'))) {
    logger.info(`\`.nuxt\` not found, running \`nuxt-module-build prepare\` first. Add it to the module's \`dev:prepare\` script to skip this step. ${guide('preparing-nuxt')}`)
    await prepareModule(cwd, { config: buildConfig, outDir, pkg })
  }

  const plan = await resolveBuild({ cwd, pkg, outDir, sourcemap: !!config.sourcemap, config: buildConfig })
  const directoryPlugins = plan.directories.map(directory => transpileDir({
    cwd,
    srcDir: directory.srcDir,
    outBase: relative(outDir, directory.outDir),
    extension: directory.ext,
    paths: plan.directoryPaths,
    transform: loadOxc()!.transform,
    sourcemap: plan.sourcemap,
    cacheVersion: plan.generatedTypesHash,
    jsx: file => preservesJsx(plan, file) ? 'preserve' : { runtime: 'automatic', importSource: 'vue' },
    resolveExternal: resolveDirectoryExternal(plan),
    reserved: [...Object.keys(plan.entries), 'types'],
  }))

  let watch = false
  let resolvedConfig: ResolvedConfig | undefined
  let failed = false
  let written: Set<string> | undefined
  let keptOutput = false
  const unchanged = unchangedOutputs(outDir)
  let builds = 0
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
    // `eager` puts every file of the tsconfig in the program, so ambient declarations such
    // as `.nuxt/nuxt.d.ts` apply and inferred types can be named by their package.
    // TODO: allow the parallel worker while watching once https://github.com/sxzz/rolldown-plugin-dts/pull/365 is released.
    // The worker inherits stdin, which tsdown reads while watching, and on Windows it then blocks at startup.
    tsc: { eager: true, parallel: !config.watch },
    compilerOptions: { paths: plan.declarationPaths },
  } as const

  Object.assign(config, {
    entry: plan.entries,
    ...config.tsconfig === undefined && plan.moduleProject && { tsconfig: plan.moduleProject },
    format: 'esm',
    outDir,
    clean: false,
    report: defaultReport(config.report, plan.directories.some(directory => existsSync(directory.srcDir))),
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
        await prepareBuild(plan, { keepOutput: watch })
        if (watch && existsSync(outDir)) {
          keptOutput = true
          written = new Set(filesIn(outDir).filter(file => !FINISHED_FILES.has(file)))
        }
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
    started: false,
    watchDirs: [...new Set(plan.runtimeDirs.map(dir => existingAncestor(dir, cwd)))],
    checkResolved(resolved) {
      watch = !!resolved.watch
      resolvedConfig = resolved
      const changed = [
        ...resolved.format !== 'es' ? ['format'] : [],
        ...Object.keys(resolved.entry).length !== Object.keys(plan.entries).length || Object.entries(plan.entries).some(([name, input]) => !resolved.entry[name] || resolve(cwd, resolved.entry[name]) !== resolve(cwd, input)) ? ['entry'] : [],
        ...resolve(resolved.outDir) !== outDir ? ['outDir'] : [],
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
    onBuildStart() {
      if (builds++) {
        plan.prepared = analyseSources(plan)
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
    async onGenerateBundle(bundle) {
      const missing = Object.keys(plan.entries).map(name => `${name}.mjs`).filter((fileName) => {
        const output = bundle[fileName]
        return output?.type !== 'chunk' || !output.isEntry
      })
      if (missing.length) {
        const error = new Error(`The build did not emit ${missing.map(fileName => `\`${fileName}\``).join(', ')}. \`builder()\` sets the file names of the bundled entries, so the tsdown config and its plugins must leave \`outputOptions.entryFileNames\` unchanged. ${guide('options-builder-sets')}`)
        await fail(error)
        throw error
      }
      unchanged.prune(bundle, { compareOutDir: keptOutput })
    },
    async onWriteBundle() {
      unchanged.commit()
      const bundle = unchanged.bundle
      const current = new Set(Object.keys(bundle))
      if (watch && written) {
        await Promise.all([...written].filter(file => !current.has(file)).map(file => rm(resolve(outDir, file), { force: true })))
      }
      written = current
      if (resolvedConfig && reportsSummary(resolvedConfig.report)) {
        for (const line of sizeBreakdown(bundle, { cwd, outDir, entries: plan.entries, directories: plan.directories })) {
          resolvedConfig.logger.info(resolvedConfig.nameLabel, line)
        }
      }
      const outputs = await Promise.all(directoryPlugins.map(plugin => plugin.api.outputs))
      await finishBuild(plan, {
        outputs: outputs.flatMap(map => [...map.values()]),
        builder: { tsdown: await readPackageJSON('tsdown', { from: import.meta.url }).then(r => r.version || 'unknown').catch(() => 'unknown') },
        keepOutput: watch,
      })
    },
  }
  return session
}

/**
 * rolldown's built-in replace plugin. It is loaded from the copy of rolldown that
 * tsdown runs, because built-in plugins only work with the binding that created them.
 */
async function replacePlugin({ values, ...options }: ReplaceOptions): Promise<Rolldown.RolldownPluginOption> {
  const tsdown = await resolvePath('tsdown', { url: import.meta.url })
  const plugins = await resolvePath('rolldown/plugins', { url: tsdown })
  const { replacePlugin } = await import(pathToFileURL(plugins).href) as { replacePlugin: (values: Record<string, string>, options: Omit<ReplaceOptions, 'values'>) => Rolldown.RolldownPluginOption }
  return replacePlugin(values, options)
}

/** The files that `finishBuild` writes after the bundle. */
const FINISHED_FILES = new Set(['module.json', 'types.d.mts'])

function filesIn(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(dir, `${entry.parentPath}/${entry.name}`))
}

/** `dir`, or the closest directory above it that exists, so a watcher sees `dir` being created. */
function existingAncestor(dir: string, root: string) {
  return findUp(dir, ancestor => existsSync(ancestor) || ancestor === root ? ancestor : undefined)!
}
