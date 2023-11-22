import { describe, expectTypeOf, it } from 'vitest'
import { useNuxtApp } from '#app'

describe('', () => {
  it('should have typed injection', () => {
    expectTypeOf(useNuxtApp().$injection).toEqualTypeOf<'injected'>()
  })
  it('should have typed runtime hooks', () => {
    useNuxtApp().hook('my-module:runtime-hook', () => {})
  })
  it('should have typed runtime config', () => {
    expectTypeOf(useRuntimeConfig().public.NAME).toEqualTypeOf<string>()
    expectTypeOf(useRuntimeConfig().PRIVATE_NAME).toEqualTypeOf<string>()
  })
})
