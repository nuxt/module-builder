import { defineNuxtPlugin } from '#imports'

export default defineNuxtPlugin(() => {
  // eslint-disable-next-line no-console
  console.log('Plugin injected by my-module!')
  return {
    provide: {
      injection: 'injected' as const
    }
  }
})
