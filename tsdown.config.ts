import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: './src/cli.ts', index: './src/index.ts', rolldown: './src/rolldown/index.ts' },
  format: 'esm',
  dts: true,
  publint: { level: 'error' },
  attw: { level: 'error', ignoreRules: ['cjs-resolves-to-esm'] },
})
