import type { NuxtConfig, NuxtModule } from '@nuxt/schema'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { resolve } from 'pathe'
import { readPackageJSON } from 'pkg-types'
import { assertNoLegacyBuildConfig, bundledEntries, loadBuildConfig, resolveModuleOptions } from '../build/build-config.ts'
import type { TranslatedBuildConfig } from '../build/build-config.ts'
import { assertResolvableImports, importModule } from '../build/loader.ts'
import { loadModuleConfig, resolveCwdArg, sharedArgs } from './_shared.ts'

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
  assertResolvableImports(cwd, Object.values(entries), runtimeDirs)
  const moduleExports = await importModule(resolve(cwd, entries.module), { cwd, runtimeDirs })
  const nuxtModule = (moduleExports.default ?? moduleExports) as NuxtModule
  const entryPath = resolve(cwd, './src/module')

  return runCommand('prepare', [cwd], {
    overrides: {
      compatibilityDate: '2024-04-03',
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
}

const command: CommandDef<typeof sharedArgs> = defineCommand({
  meta: {
    name: 'prepare',
    description: 'Prepare @nuxt/module-builder environment by writing types and stubs',
  },
  args: {
    ...sharedArgs,
  },
  async run(context) {
    return prepareModule(resolveCwdArg(context.args))
  },
})

export default command
