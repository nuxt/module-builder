// TODO: investigate how to avoid the need for this import
import type {} from 'ofetch'
import { useFetch } from '#app'

export const useWrappedFetch = () => {
  return useFetch('/api/applications')
}
