import { defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  apiKey: string
}

export interface ModuleHooks {
  'my-module:init': any
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
  defaults: {
    apiKey: null
  },
  setup (_options, _nuxt) {}
})
