export default defineNuxtConfig({
  modules: ['my-module'],
  hooks: {
    'my-module:init'(sharedType) {
      // @ts-expect-error invalid assignment
      const _b: number = sharedType
    },
  },
  myModule: {
    apiKey: '',
    // @ts-expect-error invalid configuration key
    api: '',
  },
})
