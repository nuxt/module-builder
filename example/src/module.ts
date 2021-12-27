import { defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  apiKey: string
}

export interface ModuleHooks {
  'my-module:options': (options: ModuleOptions) => Promise<void>|void
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'my-module',
    configKey: 'myModule'
  },
  defaults: {
    apiKey: null
  },
  async setup (_options, _nuxt) {
    await _nuxt.callHook('my-module:options', _options)
  }
})
