import { defineConfig } from 'vitest/config'

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    coverage: {},
    globalSetup: ['./test/setup.ts'],
    env: { NUXT_MODULE_BUILDER_DECLARATION_ENGINE: 'typescript' },
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
})

export default config
