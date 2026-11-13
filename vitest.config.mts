import { defineConfig } from 'vitest/config'

const config: ReturnType<typeof defineConfig> = defineConfig({
  test: {
    coverage: {},
    fileParallelism: false,
  },
})

export default config
