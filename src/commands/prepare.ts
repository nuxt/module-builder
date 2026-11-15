import { pathToFileURL } from 'node:url'
import type { Nuxt, NuxtConfig, NuxtModule } from '@nuxt/schema'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { resolvePathSync } from 'mlly'
import { resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import { assertNoLegacyBuildConfig, bundledEntries, loadBuildConfig, resolveModuleOptions } from '../build/build-config.ts'
import type { TranslatedBuildConfig } from '../build/build-config.ts'
import { assertLoadableModuleCode, importModule } from '../build/loader.ts'
import { writeSourceTypes } from '../build/types.ts'
import { assertNoStubArg, loadModuleConfig, resolveCwdArg, sharedArgs } from './_shared.ts'

async function loadPrepareConfig(cwd: string): Promise<TranslatedBuildConfig> {
  const pkg = await readPackageJSON(cwd)
  const moduleConfig = await loadModuleConfig(cwd)
  const outDir = resolve(cwd, moduleConfig?.outDir ?? 'dist')
  if (!moduleConfig) {
    return loadBuildConfig(cwd, pkg, outDir)
  }
  assertNoLegacyBuildConfig(cwd, pkg)
  return resolveModuleOptions(cwd, pkg, outDir, moduleConfig.options)
}

export async function prepareModule(cwd: string, buildConfig?: TranslatedBuildConfig): Promise<{ result: unknown }> {
  const { runCommand } = await import('@nuxt/cli')

  const config = buildConfig ?? await loadPrepareConfig(cwd)
  const runtimeDirs = [resolve(cwd, 'src/runtime'), ...config.directories.map(directory => directory.srcDir)]
  const entries = bundledEntries(cwd, config)
  assertLoadableModuleCode(cwd, [entries.module], runtimeDirs, Object.values(entries))
  const moduleExports = await importModule(resolve(cwd, entries.module), { cwd })
  const nuxtModule = (moduleExports.default ?? moduleExports) as NuxtModule
  const entryPath = resolve(cwd, './src/module')
  const { name } = await readPackageJSON(cwd)
  const useNuxt = name ? await loadUseNuxt(cwd) : undefined

  const result = await runCommand('prepare', [cwd], {
    overrides: {
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
      },
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
            for (const template of app.templates) {
              template.write = true
            }
          })
        },
      ],
    } satisfies NuxtConfig,
  })
  await writeSourceTypes(resolve(cwd, '.nuxt/module-builder'), resolve(cwd, entries.module))
  return result
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
  for (const id of ['@nuxt/kit', 'nuxt/kit']) {
    const path = tryResolvePath(id, cwd)
    if (path) {
      return (await import(pathToFileURL(path).href) as { useNuxt: () => Nuxt }).useNuxt
    }
  }
}

function tryResolvePath(id: string, cwd: string) {
  try {
    return resolvePathSync(id, { url: pathToFileURL(`${cwd}/`) })
  }
  catch {
    return undefined
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
