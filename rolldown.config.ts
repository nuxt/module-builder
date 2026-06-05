import { defineConfig } from 'rolldown'
import { dts } from 'rolldown-plugin-dts'

export default defineConfig({
  input: [
    './src/cli.ts',
    './src/index.ts',
  ],
  platform: 'node',
  external: /^(?!\.|\/|[a-z]:[\\/])/i,
  plugins: [
    dts(),
  ],
  output: {
    entryFileNames: '[name].mjs',
    chunkFileNames: '[name].mjs',
  },
})
