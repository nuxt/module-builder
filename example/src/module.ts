import { defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  apiKey: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'my-module',
    configKey2: 'myModule'
  },
  defaults: {
    apiKey: null
  },
  setup (_options, _nuxt) {}
})
