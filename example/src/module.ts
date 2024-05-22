import { defineNuxtModule, addPlugin, createResolver } from '@nuxt/kit'

// https://github.com/nuxt/module-builder/issues/242
import type { SharedTypeFromRuntime } from './runtime/plugins/plugin'

// Module options TypeScript interface definition
export interface ModuleOptions {
  apiKey: string
  shared?: SharedTypeFromRuntime
}

export interface ModuleHooks {
  'my-module:init': (sharedType: SharedTypeFromRuntime) => void
}

export interface ModuleRuntimeHooks {
  'my-module:runtime-hook': () => void
}

export interface ModulePublicRuntimeConfig {
  NAME: string
}

export interface ModuleRuntimeConfig {
  PRIVATE_NAME: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'my-module',
    configKey: 'myModule',
  },
  // Default configuration options of the Nuxt module
  defaults: {
    apiKey: '',
  },
  setup(_options, _nuxt) {
    const resolver = createResolver(import.meta.url)

    // @ts-expect-error type should be resolved
    _options.shared = 'not-shared-type'

    // Do not add the extension since the `.ts` will be transpiled to `.mjs` after `npm run prepack`
    addPlugin(resolver.resolve('./runtime/plugins/plugin'))
  },
})
