export default defineNuxtConfig({
  modules: ['my-module'],
  myModule: {
    apiKey: '',
    // @ts-expect-error invalid configuration key
    api: ''
  },
  hooks: {
    'my-module:init' () {}
  }
})
