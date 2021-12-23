import { defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  apiKey: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'my-module',
    configKey: 'myModule'
  },
  defaults: {
    apiKey: null
  },
  setup (options, _nuxt) {
    // eslint-disable-next-line no-console
    console.log('My module options:', options)
  }
})
