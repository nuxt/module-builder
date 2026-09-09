import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/cli.ts', './src/index.ts'],
  format: 'esm',
  dts: true,
  publint: { level: 'error' },
  attw: { level: 'error', ignoreRules: ['cjs-resolves-to-esm'] },
})
