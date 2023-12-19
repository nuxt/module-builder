import { defineNuxtModule, addPlugin, createResolver } from '@nuxt/kit'

// Module options TypeScript interface definition
export interface ModuleOptions {
  apiKey: string
}

export interface ModuleHooks {
  'my-module:init': () => void
}

export interface ModuleRuntimeHooks {
  'my-module:runtime-hook': any
}

/**
 * @deprecated `RuntimeModuleHooks` is a deprecated naming and will be removed in the future. Please use `ModuleRuntimeHooks` instead.
 */
export interface RuntimeModuleHooks {
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
    configKey: 'myModule'
  },
  // Default configuration options of the Nuxt module
  defaults: {
    apiKey: ''
  },
  setup (_options, _nuxt) {
    const resolver = createResolver(import.meta.url)

    // Do not add the extension since the `.ts` will be transpiled to `.mjs` after `npm run prepack`
    addPlugin(resolver.resolve('./runtime/plugin'))
  }
})
