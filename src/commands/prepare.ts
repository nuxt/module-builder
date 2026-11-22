import { pathToFileURL } from 'node:url'
import type { Nuxt, NuxtConfig, NuxtModule } from '@nuxt/schema'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { readFile, writeFile } from 'node:fs/promises'
import { parseTsconfig } from 'get-tsconfig'
import { dirname, join, relative, resolve } from 'pathe'
import { glob } from 'tinyglobby'
import { moduleTsconfigs } from '../build/build.ts'
import { assertSupportedTypescript, loadDeclarationEngine } from '../build/engine.ts'
import { assertLoadableModuleCode, importModule } from '../build/loader.ts'
import { moduleDeclarationPaths, writeModuleDeclarations } from '../build/module-declarations.ts'
import { bundledEntries, resolveModuleOptions } from '../build/options.ts'
import type { ModuleConfig } from '../build/options.ts'
import { selfReferencePaths } from '../build/package.ts'
import { augmentsNuxtTypes, writeSourceTypes } from '../build/types.ts'
import { noteUncheckedFiles } from '../build/unchecked.ts'
import { loadBuildConfig } from '../legacy/build-config.ts'
import { hasIsolatedDeclarations, isModuleFile, rootTsconfig, writeDependencyImports } from '../transpile/tsconfig.ts'
import { loadTypescript } from '../transpile/typescript.ts'
import { isInside, probe, readPackageJson, resolveFrom } from '../utils.ts'
import type { PackageJson } from '../utils.ts'
import { assertNoStubArg, resolveCwdArg, sharedArgs } from './_shared.ts'
import { loadModuleConfig } from './config-file.ts'

const BUILD_DECLARATION_RE = /^declare module "#build\/(.+)";$/
const PATH_OPTIONS = new Set(['paths', 'baseUrl', 'rootDir', 'rootDirs', 'outDir', 'outFile', 'declarationDir', 'typeRoots', 'tsBuildInfoFile'])

interface PrepareConfig {
  config: ModuleConfig
  outDir: string
  pkg: PackageJson
}

async function loadPrepareConfig(cwd: string): Promise<PrepareConfig> {
  const pkg = await readPackageJson(cwd)
  const moduleConfig = await loadModuleConfig(cwd)
  const outDir = resolve(cwd, moduleConfig?.outDir ?? 'dist')
  const config = moduleConfig ? resolveModuleOptions(cwd, pkg, outDir, moduleConfig.options) : await loadBuildConfig(cwd, pkg, outDir)
  return { config, outDir, pkg }
}

/**
 * The module's `.d.ts` files outside the runtime directories and `exclude`, split
 * into those that only declare globals and ambient modules, and module augmentations. Other
 * modules, which only declare types for files that import them, are left out.
 */
const DECLARE_RE = /\bdeclare\s+(?:module|global)\b/

/** Whether a file of module code outside the runtime directories, or a bundled entry, may declare a module or a global. */
async function declaresModules(cwd: string, runtimeDirs: string[], entries: string[]) {
  const ignore = ['**/node_modules/**', ...runtimeDirs.map(dir => `${relative(cwd, dir)}/**`)]
  const files = new Set([...await glob(['src/**/*.{ts,mts,cts,tsx}'], { cwd, absolute: true, ignore }), ...entries])
  const sources = await Promise.all([...files].map(file => readFile(file, 'utf8')))
  return sources.some(source => DECLARE_RE.test(source))
}

async function ambientDeclarations(cwd: string, runtimeDirs: string[], exclude: string[]) {
  const { ts } = loadTypescript()
  const ignore = [...runtimeDirs, ...exclude].flatMap((pattern) => {
    const path = relative(cwd, pattern)
    return [path, `${path}/**`]
  })
  const files = await glob(['**/*.d.ts'], { cwd, absolute: true, ignore: [...ignore, '**/node_modules/**'] })
  const globals: string[] = []
  const augmentations: string[] = []
  for (const file of files.filter(file => isModuleFile(file, cwd)).sort()) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest)
    if (!ts.isExternalModule(source)) {
      globals.push(file)
    }
    else if (source.statements.some(statement => ts.isModuleDeclaration(statement))) {
      augmentations.push(file)
    }
  }
  return { globals, augmentations }
}

export interface PrepareModuleOptions {
  /**
   * Writes the declarations of module code that the module's own app, server and shared type
   * checks resolve its package name to. A build that prepares `.nuxt` itself leaves them out,
   * unless the module entry may export interfaces that `types.d.mts` merges into Nuxt's types, or
   * module code declares a module or a global: the runtime declarations read those.
   */
  declarations?: boolean
}

export async function prepareModule(cwd: string, prepareConfig?: PrepareConfig, { declarations = true }: PrepareModuleOptions = {}): Promise<{ result: unknown }> {
  await assertSupportedTypescript()
  const { runCommand } = await import('@nuxt/cli')

  const { config, outDir, pkg } = prepareConfig ?? await loadPrepareConfig(cwd)
  const runtimeDirs = [resolve(cwd, 'src/runtime'), ...config.directories.map(directory => directory.srcDir)]
  const entries = bundledEntries(cwd, config)
  assertLoadableModuleCode(cwd, [entries.module], runtimeDirs, Object.values(entries))
  const entryPath = resolve(cwd, entries.module)
  const moduleExports = await importModule(entryPath, { cwd })
  const nuxtModule = (moduleExports.default ?? moduleExports) as NuxtModule
  const { name } = pkg
  const useNuxt = name ? await loadUseNuxt(cwd) : undefined
  const rootConfig = await rootTsconfig(cwd)
  const ambient = await ambientDeclarations(cwd, runtimeDirs, [...rootConfig.exclude ?? [], outDir])
  const selfPaths = selfReferencePaths(cwd, pkg, outDir, entries)
  const sourceTypesDir = resolve(cwd, '.nuxt/module-builder')
  const nodeAppEntry = resolve(cwd, '.nuxt/nuxt.module.d.ts')
  const declarationsDir = join(sourceTypesDir, 'declarations')
  const ownTypes = join(declarationsDir, 'types.d.mts')
  const own = name ? moduleDeclarationPaths(cwd, declarationsDir, name, selfPaths, runtimeDirs) : { paths: {}, sources: [] }
  const ownPaths = own.paths
  let perContext = false
  const isOwnTypes = (reference: { path: string } | { types: string }) => 'types' in reference && (reference.types === name || reference.types === entryPath)
  const compilerOptions = Object.fromEntries(Object.entries(rootConfig.compilerOptions).filter(([key]) => !PATH_OPTIONS.has(key)))
  const withRootOptions = (options: Record<string, unknown> = {}) => ({
    ...options,
    ...compilerOptions,
    ...compilerOptions.types !== undefined && { types: [...new Set([...options.types as string[] ?? [], ...compilerOptions.types as string[]])] },
  })

  const result = await runCommand('prepare', [cwd], {
    overrides: {
      buildDir: resolve(cwd, '.nuxt'),
      typesDir: resolve(cwd, '.nuxt'),
      compatibilityDate: '2024-04-03',
      hooks: {
        'modules:before': () => {
          const options = useNuxt?.().options
          for (const modules of options ? [options.modules, ...options._layers.map(layer => layer.config.modules)] : []) {
            replaceEntries(modules as unknown[] | undefined, name!, nuxtModule)
          }
        },
      },
      typescript: {
        builder: 'shared',
        tsConfig: { exclude: rootConfig.exclude ?? [] },
      },
      nitro: { typescript: { tsConfig: { ...ambient.globals.length && { files: ambient.globals }, compilerOptions: withRootOptions() } } },
      imports: {
        autoImport: false,
      },
      modules: [
        nuxtModule,
        // Nuxt derives the module's type reference and `types/modules.d.ts` from the entry path recorded here.
        function (_options, nuxt) {
          const installed = nuxt.options._installedModules.find(m => m.module === nuxtModule)
          if (installed) {
            installed.entryPath = entryPath
          }
          const index = nuxt.options.modules.indexOf(nuxtModule)
          if (index !== -1) {
            nuxt.options.modules[index] = entryPath
          }
          nuxt.hooks.hook('app:templates', (app) => {
            const virtual = new Set(app.templates.filter(template => !template.write).map(template => template.filename))
            for (const template of app.templates) {
              template.write = true
            }
            // `types/build.d.ts` only declares templates kept in memory; of those written here, it keeps the specifiers TypeScript does not resolve.
            const buildTypes = app.templates.find(template => template.filename === 'types/build.d.ts')
            const getContents = buildTypes?.getContents
            if (buildTypes && getContents) {
              buildTypes.getContents = async (data) => {
                const written = new Set(data.app.templates.map(template => template.filename))
                const resolves = (path: string) => ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx'].some(extension => written.has(path + extension))
                const contents = await getContents({ ...data, app: { ...data.app, templates: data.app.templates.map(template => virtual.has(template.filename) ? { ...template, write: false } : template) } })
                return contents.split('\n').filter(line => !resolves(line.match(BUILD_DECLARATION_RE)?.[1] ?? '')).join('\n')
              }
            }
          })
          // Nuxt adds `dist` paths in the directory of each module's entry, the package root of an installed module.
          const entryDist = dirname(entryPath) === cwd ? undefined : join(relative(nuxt.options.buildDir, dirname(entryPath)), 'dist')
          const outsideEntryDist = (pattern: string) => entryDist === undefined || (pattern !== entryDist && !pattern.startsWith(`${entryDist}/`))
          // Nuxt 3 generates a single tsconfig, which is left as it is.
          nuxt.hooks.hook('prepare:types', ({ nodeTsConfig }) => {
            perContext = nodeTsConfig !== undefined
          })
          nuxt.hooks.hook('nitro:init', (nitro) => {
            nitro.hooks.hook('types:extend', ({ tsConfig }: { tsConfig?: { include?: string[], exclude?: string[], compilerOptions?: { paths?: Record<string, string[]> } } }) => {
              if (tsConfig) {
                tsConfig.include &&= tsConfig.include.filter(outsideEntryDist)
                tsConfig.exclude &&= tsConfig.exclude.filter(outsideEntryDist)
              }
              if (tsConfig && perContext) {
                tsConfig.compilerOptions = withTsExtensions({ ...tsConfig.compilerOptions, paths: { ...tsConfig.compilerOptions?.paths, ...ownPaths } })
              }
            })
          })
          // Registered once every module is set up, so that it sees the aliases and options they add.
          nuxt.hooks.hook('modules:done', () => {
            nuxt.hooks.hook('prepare:types', ({ references, nodeReferences = [], tsConfig, nodeTsConfig, serverTsConfig, sharedTsConfig }) => {
              if (!nodeTsConfig) {
                return
              }
              // The app's tsconfig covers the module root as a Nuxt app's source directory, and the workspace, so it is narrowed to the runtime directories.
              const rootGlobs = new Set([cwd, nuxt.options.workspaceDir].flatMap((dir) => {
                const root = relative(nuxt.options.buildDir, dir) || '.'
                return [join(root, '**/*'), join(root, '**/*.vue')]
              }))
              tsConfig.include = [...(tsConfig.include ?? []).filter(pattern => !rootGlobs.has(pattern)), ...runtimeDirs.filter(dir => !dir.startsWith(`${runtimeDirs[0]}/`))]
              tsConfig.exclude = [...tsConfig.exclude ?? [], resolve(cwd, '**/nuxt.config.*')]
              for (const context of [tsConfig, nodeTsConfig, serverTsConfig, sharedTsConfig].filter(context => context !== undefined)) {
                context.include &&= context.include.filter(outsideEntryDist)
                context.exclude &&= context.exclude.filter(outsideEntryDist)
                context.compilerOptions = withTsExtensions(withRootOptions(context.compilerOptions))
                if (ambient.globals.length) {
                  context.files = [...context.files ?? [], ...ambient.globals]
                }
              }
              // Referenced from the declaration entries, so that the augmentations follow Nuxt's own declarations.
              for (const list of [references, nodeReferences]) {
                list.push(...ambient.augmentations.map(path => ({ path })))
              }
              // Module code can import types from runtime sources, which rely on the app's aliases, declarations and JSX options.
              const appEntry = join(nuxt.options.buildDir, 'nuxt.d.ts')
              const appDeclarations = (tsConfig.include ?? [])
                .filter(pattern => isInside(nuxt.options.buildDir, resolve(nuxt.options.buildDir, pattern)))
                .map(pattern => rootConfig.references && resolve(nuxt.options.buildDir, pattern) === appEntry ? `./${relative(nuxt.options.buildDir, nodeAppEntry)}` : pattern)
              nodeTsConfig.include = [...new Set([...nodeTsConfig.include ?? [], ...appDeclarations])]
              // A type reference does not resolve the module's own package name.
              const ownReference = nodeReferences.findIndex(isOwnTypes)
              nodeReferences.splice(ownReference === -1 ? nodeReferences.length : ownReference, ownReference === -1 ? 0 : 1, { path: join(sourceTypesDir, 'types.d.mts') })
              const { jsx, jsxImportSource } = tsConfig.compilerOptions ?? {}
              // Module code loads with Node, so the module code project reports the syntax that type stripping cannot remove.
              nodeTsConfig.compilerOptions = { ...rootConfig.references && { erasableSyntaxOnly: true }, jsx, jsxImportSource, ...nodeTsConfig.compilerOptions }
              nodeTsConfig.compilerOptions.paths = { ...tsConfig.compilerOptions?.paths, ...nodeTsConfig.compilerOptions.paths }
              // The module's own package resolves to declarations of module code here, so module code is not type checked in these parts.
              // Included rather than referenced from `nuxt.d.ts`, which `.nuxt/tsconfig.json` also includes.
              const appReference = references.findIndex(isOwnTypes)
              if (appReference !== -1) {
                references.splice(appReference, 1)
              }
              if (name) {
                tsConfig.include = [...tsConfig.include ?? [], ownTypes]
              }
              for (const context of [tsConfig, serverTsConfig, sharedTsConfig].filter(context => context !== undefined)) {
                context.compilerOptions = { ...context.compilerOptions, paths: { ...context.compilerOptions?.paths, ...ownPaths } }
              }
            })
          })
        },
      ],
    } satisfies NuxtConfig,
  })
  await writeSourceTypes(sourceTypesDir, entryPath)
  if (perContext && rootConfig.references) {
    await writeNodeAppDeclarations(resolve(cwd, '.nuxt'), nodeAppEntry)
  }
  await writeCompatibilityTsconfig(resolve(cwd, '.nuxt/tsconfig.json'), cwd, { ownPaths, ownTypes, entryPath, ambient: ambient.globals })
  if (perContext) {
    await noteUncheckedFiles(cwd, { outDir, exclude: rootConfig.exclude ?? [] })
  }
  if (name && perContext && (declarations || augmentsNuxtTypes(entryPath) || await declaresModules(cwd, runtimeDirs, Object.values(entries).flatMap(input => probe(resolve(cwd, input)) ?? [])))) {
    const roots = [...Object.values(entries).flatMap(input => probe(resolve(cwd, input)) ?? []).filter(file => !runtimeDirs.some(dir => isInside(dir, file))), ...own.sources]
    const tsconfigs = await moduleTsconfigs(cwd)
    const project = tsconfigs.resolve(entryPath)
    const nodeTsconfig = resolve(cwd, '.nuxt/tsconfig.node.json')
    const tsconfig = project && project !== tsconfigs.root ? project : { path: nodeTsconfig, config: parseTsconfig(nodeTsconfig) }
    const imports = await writeDependencyImports(cwd, tsconfigs.root)
    const isolated = config.isolatedDeclarations ?? hasIsolatedDeclarations(tsconfig)
    const engine = isolated ? undefined : await loadDeclarationEngine(cwd, config)
    try {
      await writeModuleDeclarations(cwd, declarationsDir, { tsconfig, entry: entryPath, roots, paths: selfPaths, imports, engine, isolated })
    }
    finally {
      await engine?.close()
    }
  }
  return result
}

const REFERENCE_PATH_RE = /^\/\/\/ <reference path="([^"]+)" \/>$/

/**
 * Writes to `file`, next to the app's `nuxt.d.ts` in `buildDir` so that its relative imports
 * resolve the same, a copy of it for the module code project without Nitro's
 * `types/nitro-imports.d.ts`. That file only re-exports the server's auto-imports for `#imports`
 * in the server part, and refers to the module's server sources.
 */
async function writeNodeAppDeclarations(buildDir: string, file: string) {
  const serverImports = join(buildDir, 'types/nitro-imports.d.ts')
  const referenced = (from: string, line: string) => {
    const path = line.match(REFERENCE_PATH_RE)?.[1]
    return path && resolve(dirname(from), path)
  }
  const reference = (target: string) => `/// <reference path="${relative(dirname(file), target)}" />`
  const appEntry = join(buildDir, 'nuxt.d.ts')
  const lines: string[] = []
  for (const line of (await readFile(appEntry, 'utf8')).split('\n')) {
    const target = referenced(appEntry, line)
    const nested = target && isInside(buildDir, target) ? (await readFile(target, 'utf8').catch(() => '')).split('\n').filter(line => line.startsWith('/// <reference ')) : []
    if (!target) {
      lines.push(line)
    }
    else if (nested.some(line => referenced(target, line) === serverImports)) {
      lines.push(...nested.flatMap((line) => {
        const nestedTarget = referenced(target, line)
        return nestedTarget === serverImports ? [] : [nestedTarget ? reference(nestedTarget) : line]
      }))
    }
    else if (target !== serverImports) {
      lines.push(reference(target))
    }
  }
  await writeFile(file, lines.join('\n'))
}

interface CompatibilityOptions {
  ownPaths: Record<string, string[]>
  ownTypes: string
  entryPath: string
  /** The module's ambient declarations, which the program's `include` already covers. */
  ambient: string[]
}

/**
 * Rewrites `.nuxt/tsconfig.json`, one program over the module root, without the app's mapping of
 * the module's own package to declarations of module code, as that program has its sources, and
 * without the paths Nuxt derives from the directory of the module's entry, which exclude its
 * server runtime.
 */
async function writeCompatibilityTsconfig(file: string, cwd: string, { ownPaths, ownTypes, entryPath, ambient }: CompatibilityOptions) {
  const config = JSON.parse(await readFile(file, 'utf8')) as { include?: string[], exclude?: string[], files?: string[], compilerOptions?: { paths?: Record<string, string[]> } }
  config.files = config.files?.filter(path => !ambient.includes(resolve(dirname(file), path)))
  if (!config.files?.length) {
    delete config.files
  }
  const entryDir = dirname(entryPath)
  const isDerived = (pattern: string) => {
    const path = resolve(dirname(file), pattern)
    const inEntryDist = entryDir !== cwd && isInside(join(entryDir, 'dist'), path)
    return path === ownTypes || path === join(entryDir, 'runtime/server') || inEntryDist
  }
  config.include = config.include?.filter(pattern => !isDerived(pattern))
  config.exclude = config.exclude?.filter(pattern => !isDerived(pattern))
  for (const alias of Object.keys(ownPaths)) {
    delete config.compilerOptions?.paths?.[alias]
  }
  if (config.compilerOptions) {
    config.compilerOptions = withTsExtensions(config.compilerOptions)
  }
  await writeFile(file, JSON.stringify(config, null, 2))
}

/**
 * `options` with `allowImportingTsExtensions`, which module code needs for its `.ts` imports,
 * unless they set it or emit JavaScript. Nuxt sets it in the tsconfigs it generates from 4.5 on.
 */
function withTsExtensions<T extends Record<string, unknown>>(options: T): T {
  return options.allowImportingTsExtensions === undefined && (options.noEmit || options.emitDeclarationOnly) ? { ...options, allowImportingTsExtensions: true } : options
}

/**
 * Replaces the entries of `modules` that install the package `name` with `nuxtModule`, keeping
 * their options, so the module is installed once from its sources whether or not `dist` exists.
 */
function replaceEntries(modules: unknown[] | undefined, name: string, nuxtModule: NuxtModule) {
  for (let index = (modules?.length ?? 0) - 1; index >= 0; index--) {
    const entry = modules![index]
    if ((Array.isArray(entry) ? entry[0] : entry) !== name) {
      continue
    }
    if (Array.isArray(entry) && entry[1]) {
      modules![index] = [nuxtModule, entry[1]]
    }
    else {
      modules!.splice(index, 1)
    }
  }
}

/** `useNuxt` from the kit the module in `cwd` resolves, so hooks can read the Nuxt instance they run in. */
async function loadUseNuxt(cwd: string): Promise<(() => Nuxt) | undefined> {
  const nuxt = resolveFrom(`${cwd}/`, 'nuxt/package.json')
  // `nuxt/kit` re-exports the `@nuxt/kit` that `nuxt` depends on, and some versions of `nuxt` export it only for `import`.
  const path = resolveFrom(`${cwd}/`, '@nuxt/kit') ?? (nuxt && resolveFrom(nuxt, '@nuxt/kit'))
  if (path) {
    return (await import(pathToFileURL(path).href) as { useNuxt: () => Nuxt }).useNuxt
  }
}

const command: CommandDef<typeof sharedArgs> = defineCommand({
  meta: {
    name: 'prepare',
    description: 'Prepare @nuxt/module-builder environment by writing types',
  },
  args: sharedArgs,
  async run(context) {
    assertNoStubArg('prepare', context.args)
    return prepareModule(resolveCwdArg(context.args))
  },
})

export default command
