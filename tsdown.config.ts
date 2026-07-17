import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts'],
  format: 'esm',
  dts: true,
})
