import { isAbsolute } from 'pathe'
import type { Rolldown } from 'tsdown'

const DECLARATION_RE = /\.d\.[cm]?ts$/
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/

/**
 * Keeps declaration imports of installed packages external, whether or not the package
 * is a dependency. Aliases that resolve into the module's own source are bundled.
 */
export function externalDependencyDeclarations(): Rolldown.Plugin {
  return {
    name: 'nuxt-module-builder:external-dependency-declarations',
    resolveId: {
      order: 'pre',
      async handler(id, importer, options) {
        if (!importer || !DECLARATION_RE.test(importer) || id.startsWith('.') || id.startsWith('\0') || isAbsolute(id)) {
          return
        }
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true })
        if (resolved?.external) {
          return resolved
        }
        if (!resolved || NODE_MODULES_RE.test(resolved.id)) {
          return { id, external: true }
        }
      },
    },
  }
}
