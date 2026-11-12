import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, normalize, relative, resolve } from 'pathe'
import { consola } from 'consola'
import { readPackageJSON } from 'pkg-types'
import { glob } from 'tinyglobby'
import { build as tsdownBuild } from 'tsdown'
import type { InlineConfig } from 'tsdown'

import builderPkg from '../../package.json' with { type: 'json' }
import { probe as probeSource, scriptExtension, valueSpecifiers } from '../rolldown/resolve.ts'
import { DEFAULT_EXCLUDE, transpileDir, TYPE_ERRORS_WARNING } from '../rolldown/transpile-dir.ts'
import { createTsconfigResolver, declarationPaths, findPackageDir, tsconfigPaths, writeDerivedTsconfig, writeServerRoutesStub } from '../rolldown/tsconfig.ts'
import { shouldAdvise } from './advice.ts'
import { rewriteRuntimeDeclarations } from './aliases.ts'
import { bundledEntries, callBuildHook, createBuildContext, formatUnsupportedOptions, loadBuildConfig, resolveOutDir, warnDeprecatedBuildConfig } from './build-config.ts'
import type { DirectoryEntry } from './build-config.ts'
import { externalDependencyDeclarations, NUXT_EXTERNALS } from './externals.ts'
import { checkDeprecatedPackageFields } from './deprecations.ts'
import { guide } from './guide.ts'
import { assertResolvableImports, loadOxc, probe } from './loader.ts'
import { writeModuleMeta } from './meta.ts'
import { replacePlugin } from './replace.ts'
import { runtimeExternals } from './runtime-externals.ts'
import { hasIsolatedDeclarations, selfReferencePaths } from './tsconfig.ts'
import { writeTypes } from './types.ts'

export interface BuildOptions {
  outDir: string
  sourcemap: boolean
}

const ISOLATED_DECLARATIONS_HINT = [
  'Declaration generation failed under `isolatedDeclarations`.',
  'Every exported value needs an explicit type annotation. In particular, a module entry has to be written as:',
  '',
  '  const module: NuxtModule<ModuleOptions> = defineNuxtModule({ /* ... */ })',
  '  export default module',
  '',
  `rather than \`export default defineNuxtModule<ModuleOptions>({ /* ... */ })\`. ${guide('isolated-declarations')}`,
].join('\n')

const TYPE_ERROR_HINT = [
  'Type declarations could not be generated because of TypeScript errors.',
  `An inferred type that cannot be named (TS2742) needs an explicit type annotation on the export. ${guide('portability-errors')}`,
  `If \`.nuxt\` is out of date, run \`nuxt-module-build prepare\` and build again. ${guide('declaration-errors')}`,
].join('\n')

const SCRIPT_RE = /\.[cm]?[jt]sx?$/
const SERVER_DIR_RE = /(?:^|\/)server\//

export function shouldNudge(isolatedDeclarations: boolean): boolean {
  return !isolatedDeclarations && shouldAdvise('isolated-declarations')
}

export async function build(cwd: string, options: BuildOptions): Promise<void> {
  const pkg = await readPackageJSON(cwd)
  const outDir = resolveOutDir(cwd, options.outDir)
  const runtimeSrcDir = resolve(cwd, 'src/runtime')
  const tsconfigs = await createTsconfigResolver(cwd)
  if (tsconfigs.replaced) {
    const path = relative(cwd, tsconfigs.replaced)
    const advice = path.startsWith('..') ? 'Add a `tsconfig.json` in the module directory that extends `./.nuxt/tsconfig.json`.' : 'Extend `./.nuxt/tsconfig.json` in the module\'s tsconfig.'
    consola.info(`\`${path}\` takes its generated types from another app's \`.nuxt\`; declarations are generated with \`.nuxt/tsconfig.json\` instead. ${advice} ${guide('module-tsconfig')}`)
  }
  const selfPaths = selfReferencePaths(cwd, pkg, outDir)

  const config = await loadBuildConfig(cwd, pkg, outDir)
  if (config.unsupported.length) {
    throw new Error(formatUnsupportedOptions(config.unsupported))
  }
  warnDeprecatedBuildConfig(config)

  const directories: DirectoryEntry[] = [{ srcDir: runtimeSrcDir, outDir: join(outDir, 'runtime'), ext: 'js' }, ...config.directories]
  const sourcemap = options.sourcemap || config.sourcemap
  const ctx = createBuildContext({ cwd, outDir, pkg, config, directories, stub: false, sourcemap })

  const entries = bundledEntries(cwd, config)
  const runtimeDirs = directories.map(directory => directory.srcDir)
  await callBuildHook(config, 'build:before', ctx)
  assertResolvableImports(cwd, Object.values(entries), runtimeDirs)
  await rm(outDir, { recursive: true, force: true })

  const moduleTsconfig = tsconfigs.resolve(resolve(cwd, entries.module ?? Object.values(entries)[0]!))
  const isolatedDeclarations = hasIsolatedDeclarations(moduleTsconfig)
  // `eager` puts every file of the tsconfig in the program, so ambient declarations such
  // as `.nuxt/nuxt.d.ts` apply and inferred types can be named by their package.
  const moduleDeclarationPaths = declarationPaths({ ...selfPaths, ...tsconfigPaths(moduleTsconfig) }, cwd)
  await writeServerRoutesStub(cwd)
  const moduleDts = {
    tsconfig: moduleTsconfig ? await writeDerivedTsconfig(cwd, moduleTsconfig, selfPaths) : false,
    generator: isolatedDeclarations ? 'oxc' : 'tsc',
    tsc: { eager: true, parallel: true },
    compilerOptions: { paths: moduleDeclarationPaths.paths },
  } as const

  const bundledSources = new Map<string, string>()
  for (const [name, input] of Object.entries(entries)) {
    const file = probe(resolve(cwd, input))
    if (file) {
      bundledSources.set(normalize(file), `${name}.mjs`)
    }
  }
  const reserved = new Set([...Object.keys(entries), 'types'])
  // Nitro and Node do not transform files in `node_modules`, so JSX that runs there is compiled.
  const runtimeFiles = await Promise.all(directories.map(directory => glob(['**/*'], { cwd: directory.srcDir, ignore: DEFAULT_EXCLUDE, absolute: true, onlyFiles: true })))
  const serverFiles = runtimeFiles.flat().map(file => normalize(file)).filter(file => SCRIPT_RE.test(file) && SERVER_DIR_RE.test(relative(cwd, file)))
  const compiledJsx = await valueImports([...serverFiles, ...bundledSources.keys()])
  const preserveJsx = (file: string) => !compiledJsx.has(normalize(file))
  const nuxtDir = findPackageDir('nuxt', cwd)
  const vue = { cacheVersion: await hashGeneratedTypes(cwd) }
  const directoryPlugins = directories.map(directory => transpileDir({
    cwd,
    srcDir: directory.srcDir,
    outBase: relative(outDir, directory.outDir),
    extension: directory.ext,
    paths: { ...selfPaths, ...nuxtDir && { '#app/nuxt': [join(nuxtDir, 'dist/app/nuxt')] } },
    transform: loadOxc()?.transform,
    sourcemap,
    vue,
    jsx: file => preserveJsx(file) ? 'preserve' : { runtime: 'automatic', importSource: 'vue' },
    // Bundled entries and other directories keep their own output. Any other file is
    // mirrored where the specifier already points, or under `_external/` when that would
    // take the name of a bundled entry or `types`.
    resolveExternal(_specifier, _importer, { file, kind, from, output }) {
      const bundled = bundledSources.get(file)
      if (bundled) {
        return relativeSpecifier(from, bundled)
      }
      const other = directories.find(directory => !relative(directory.srcDir, file).startsWith('..'))
      if (other) {
        return relativeSpecifier(from, join(relative(outDir, other.outDir), relative(other.srcDir, file).replace(SCRIPT_RE, scriptExtension(file, `.${other.ext}`, preserveJsx(file)))))
      }
      if (reserved.has(output.replace(SCRIPT_RE, ''))) {
        const segments = relative(cwd, file).replace(SCRIPT_RE, scriptExtension(file, `.${directory.ext}`, preserveJsx(file))).split('/').map(segment => segment === '..' ? '_' : segment)
        return { mirror: kind, output: join('_external', ...segments) }
      }
      return { mirror: kind }
    },
  }))

  const start = Date.now()
  await tsdownBuild({
    cwd,
    config: false,
    format: 'esm',
    outDir,
    clean: false,
    report: false,
    sourcemap,
    deps: { neverBundle: [...NUXT_EXTERNALS, ...config.neverBundle] },
    entry: entries,
    dts: moduleDts,
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
      runtimeExternals({ outDir, directories, packageName: pkg.name, preserveJsx }),
      ...config.replace ? [await replacePlugin(config.replace)] : [],
      ...directoryPlugins,
    ],
  } satisfies InlineConfig).catch(async (error) => {
    await rm(outDir, { recursive: true, force: true })
    if (isolatedDeclarations && !isDirectoryError(error)) {
      consola.error(ISOLATED_DECLARATIONS_HINT)
    }
    else if (/\bTS\d{4}\b/.test(String(error?.message))) {
      consola.error(TYPE_ERROR_HINT)
    }
    throw error
  })
  const duration = Date.now() - start

  await writeModuleMeta({
    cwd,
    outDir,
    runtimeDirs,
    pkg,
    builder: {
      [builderPkg.name]: builderPkg.version,
      tsdown: await readPackageJSON('tsdown', { from: import.meta.url }).then(r => r.version || 'unknown').catch(() => 'unknown'),
    },
  }).catch((error) => {
    consola.error(error)
    consola.error('Cannot load module. Please check dist:', resolve(outDir, 'module.mjs'))
  })
  await writeTypes(outDir, false)
  await callBuildHook(config, 'rollup:done', ctx)
  const outputs = await Promise.all(directoryPlugins.map(plugin => plugin.api.outputs))
  await rewriteRuntimeDeclarations(outDir, outputs.flatMap(map => [...map.values()]))

  if (shouldNudge(isolatedDeclarations)) {
    consola.info(`Built in ${duration}ms. Set \`isolatedDeclarations: true\` in your \`tsconfig.json\` to use the faster oxc declaration generator. ${guide('isolated-declarations')}`)
  }

  await checkDeprecatedPackageFields(cwd)
  await callBuildHook(config, 'build:done', ctx)
}

async function valueImports(roots: string[]) {
  const transform = loadOxc()?.transform
  const queue = [...roots]
  const found = new Set<string>()
  while (queue.length) {
    const file = queue.pop()!
    if (found.has(file)) {
      continue
    }
    found.add(file)
    const source = await readFile(file, 'utf8')
    const code = transform
      ? (await transform(file, source, { lang: file.match(/\.[cm]?([jt]sx?)$/)![1], jsx: 'preserve', typescript: { onlyRemoveTypeImports: false } })).code
      : source
    for (const specifier of valueSpecifiers(code)) {
      const target = probeSource(resolve(dirname(file), specifier))
      if (target && SCRIPT_RE.test(target)) {
        queue.push(normalize(target))
      }
    }
  }
  return found
}

function isDirectoryError(error: unknown) {
  const errors = (error as { errors?: Array<{ plugin?: string }> } | undefined)?.errors
  return Array.isArray(errors) && errors.some(nested => nested.plugin === 'transpile-dir')
}

function relativeSpecifier(from: string, to: string) {
  const path = relative(dirname(from), to)
  return path.startsWith('.') ? path : `./${path}`
}

/**
 * A hash of the types Nuxt generates in `.nuxt/`, which augment what single-file
 * component declarations refer to without being visible to the declaration cache.
 */
async function hashGeneratedTypes(cwd: string) {
  const files = await glob(['tsconfig.json', '**/*.d.ts'], { cwd: join(cwd, '.nuxt'), absolute: true, onlyFiles: true })
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(relative(cwd, file)).update(await readFile(file))
  }
  return hash.digest('hex').slice(0, 12)
}
