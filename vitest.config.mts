import { defineConfig } from 'vitest/config'

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    coverage: {},
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})

export default config
