import { defineNuxtPlugin } from '#app'

export default defineNuxtPlugin(() => {
  console.log('Plugin injected by my-module!')
  return {
    provide: {
      injection: 'injected' as const,
    },
  }
})
