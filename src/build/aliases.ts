import { existsSync, promises as fsp } from 'node:fs'
import { dirname, join, resolve } from 'pathe'

const RELATIVE_SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]*)\2/g
const DECLARATION_TARGETS = [
  ['.d.ts', '.js'],
  ['.d.mts', '.mjs'],
  ['/index.d.ts', '/index.js'],
  ['/index.d.mts', '/index.mjs'],
] as const

/**
 * Rewrites the declarations emitted for `outputs` (paths relative to `outDir`) so they
 * resolve outside the module.
 *
 * - Relative specifiers without an extension get the one of the file they resolve to in
 *   `outDir`, so they resolve under `node16` and `nodenext` module resolution.
 * - `#app` aliases, which tsc prints whenever the real path is not reachable through
 *   `node_modules` and which only resolve inside a Nuxt app, become `nuxt/app`.
 */
export async function rewriteRuntimeDeclarations(outDir: string, outputs: string[]): Promise<void> {
  const files = outputs.flatMap(output => declarationsOf(join(outDir, output))).filter(file => existsSync(file))
  await Promise.all(files.map(async (file) => {
    const contents = await fsp.readFile(file, 'utf8')
    const rewritten = contents
      .replace(RELATIVE_SPECIFIER_RE, (match, prefix: string, quote: string, specifier: string) => {
        const resolved = resolveDeclarationSpecifier(dirname(file), specifier) ?? specifier
        return resolved === specifier ? match : `${prefix}${quote}${resolved}${quote}`
      })
      .replace(/import\("#app(?:\/[^"]*)?"\)/g, 'import("nuxt/app")')
      .replace(/(\bfrom\s*)(['"])#app(?:\/[^'"]*)?\2/g, '$1$2nuxt/app$2')

    if (rewritten !== contents) {
      await fsp.writeFile(file, rewritten, 'utf8')
    }
  }))
}

function declarationsOf(output: string) {
  if (/\.d\.[cm]?ts$/.test(output)) {
    return [output]
  }
  if (output.endsWith('.vue')) {
    return [`${output}.d.ts`, output.replace(/\.vue$/, '.d.vue.ts')]
  }
  if (output.endsWith('.jsx')) {
    return [output.replace(/\.jsx$/, '.d.ts')]
  }
  return /\.[cm]?js$/.test(output) ? [output.replace(/\.(m?)js$/, '.d.$1ts')] : []
}

function resolveDeclarationSpecifier(dir: string, specifier: string): string | undefined {
  if (/\.(?:vue|json|css)$/.test(specifier)) {
    return
  }
  const script = specifier.match(/^(.*)\.(m?)js$/)
  if (script) {
    const target = resolve(dir, specifier)
    return existsSync(target) || existsSync(target.replace(/\.(m?)js$/, '.d.$1ts'))
      ? undefined
      : resolveDeclarationSpecifier(dir, script[1]!)
  }
  const base = resolve(dir, specifier)
  for (const [declaration, extension] of DECLARATION_TARGETS) {
    if (existsSync(base + declaration)) {
      return specifier.replace(/\/$/, '') + extension
    }
  }
  if (existsSync(`${base}.vue`)) {
    return `${specifier}.vue`
  }
}
