// @ts-check
import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: {
    tooling: true,
    stylistic: true,
  },
  dirs: {
    src: [
      './example',
      './example/playground',
    ],
  },
}).append({
  ignores: ['test/__snapshots__/*'],
}, {
  files: ['src/build/**'],
  rules: {
    'no-restricted-imports': ['error', { paths: [{ name: 'tsdown', message: 'The core does not depend on tsdown; tsdown-specific code belongs in `src/tsdown/`.' }] }],
  },
})
