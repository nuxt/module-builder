// TODO: fix module-builder failing to emit correct types
import type { Plugin } from 'nuxt/app'
import { defineNuxtPlugin } from '#imports'

export default defineNuxtPlugin(() => {
  // eslint-disable-next-line no-console
  console.log('Plugin injected by my-module!')
  return {
    provide: {
      injection: 'injected' as const
    }
  }
}) as Plugin<{ injection: 'injected' }>
