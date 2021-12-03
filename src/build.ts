import { promises as fsp } from 'fs'
import { resolve } from 'pathe'

export async function buildModule (rootDir: string) {
  const { build } = await import('unbuild')

  await build(rootDir, false, {
    declaration: true,
    entries: [
      'src/module',
      { input: 'src/runtime/', outDir: 'dist/runtime', ext: 'mjs' }
    ],
    rollup: {
      emitCJS: false,
      cjsBridge: true
    },
    externals: [
      '@nuxt/schema',
      '@nuxt/schema-edge',
      '@nuxt/kit',
      '@nuxt/kit-edge'
    ],
    hooks: {
      async 'build:done' (ctx) {
        await writeCJSStub(ctx.options.outDir)
      }
    }
  })
}

async function writeCJSStub (distDir: string) {
  const cjsStubFile = resolve(distDir, 'module.cjs')
  const cjsStub = `// CommonJS proxy to use native ESM
module.exports = function(...args) {
  return import('./module.mjs').then(m => m.default.call(this, ...args))
}
module.exports.meta = require('../package.json')
`
  await fsp.writeFile(cjsStubFile, cjsStub, 'utf8')
}
