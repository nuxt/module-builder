import { useNuxtApp } from '#app'
import { useRouter } from '#app/composables/router'
import { useCookie } from '#app/composables/cookie'

export const useAppRouter = () => useRouter()

export const useAppCookie = (name: string) => useCookie(name)

export const useAppInstance = () => useNuxtApp()
