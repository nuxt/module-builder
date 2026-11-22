// Preloaded with `--require`, so that it also applies in worker threads: resolves `typescript`
// and its subpaths for every importer from `TYPESCRIPT_FROM`, as a module's own `typescript` is
// the one its dependencies resolve.
const { createRequire, registerHooks } = require('node:module')
const { pathToFileURL } = require('node:url')

const resolver = createRequire(process.env.TYPESCRIPT_FROM)
const TYPESCRIPT_RE = /^typescript(?:\/|$)/
let resolving = false

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (resolving || !TYPESCRIPT_RE.test(specifier)) {
      return nextResolve(specifier, context)
    }
    resolving = true
    try {
      return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true }
    }
    finally {
      resolving = false
    }
  },
})
