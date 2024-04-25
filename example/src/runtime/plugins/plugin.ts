import { defineNuxtPlugin } from '#app'

export type SharedTypeFromRuntime = 'shared-type'

export default defineNuxtPlugin(() => {
  console.log('Plugin injected by my-module!')
  return {
    provide: {
      injection: 'injected' as const,
    },
  }
})
