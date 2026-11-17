import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: './src/cli.ts', index: './src/index.ts', tsdown: './src/tsdown/index.ts' },
  format: 'esm',
  dts: true,
  publint: { level: 'error' },
  attw: { level: 'error', profile: 'strict', ignoreRules: ['cjs-resolves-to-esm'] },
})
