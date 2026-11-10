import { promises as fsp } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolvePath } from 'mlly'
import { join, relative } from 'pathe'

export const SASS_RE = /\.s[ac]ss$/

interface SassCompiler {
  compileString: (source: string, options: { loadPaths: string[], url: URL, syntax: 'scss' | 'indented' }) => { css: string }
}

let lightningcss: Promise<typeof import('lightningcss')> | undefined

/**
 * Flatten nesting, add the vendor prefixes the browserslist targets of `file` need, and
 * minify. Other syntax is left alone, whatever the targets. Unknown at-rules pass through
 * silently; other problems go to `warn`.
 */
export async function transformCss(file: string, cwd: string, warn: (message: string) => void) {
  const { browserslistToTargets, Features, transform } = await (lightningcss ??= import('lightningcss'))
  const { default: browserslist } = await import('browserslist')

  const allFeatures = Object.values(Features).reduce((all, feature) => all | feature, 0)
  const result = transform({
    filename: file,
    code: await fsp.readFile(file),
    minify: true,
    errorRecovery: true,
    targets: browserslistToTargets(browserslist(undefined, { path: file })),
    include: Features.Nesting,
    exclude: allFeatures & ~(Features.Nesting | Features.VendorPrefixes),
  })

  for (const warning of result.warnings) {
    if (warning.type === 'AtRuleInvalid' && warning.message.startsWith('Unknown at rule')) {
      continue
    }
    warn(`${relative(cwd, file)}:${warning.loc.line}:${warning.loc.column}: ${warning.message}`)
  }

  return result.code
}

const sassCompilers = new Map<string, Promise<SassCompiler>>()

/** Compile a Sass stylesheet with the `sass` or `sass-embedded` installed under `cwd`. */
export async function compileSass(file: string, cwd: string) {
  let compiler = sassCompilers.get(cwd)
  if (!compiler) {
    compiler = loadSass(cwd)
    sassCompilers.set(cwd, compiler)
  }

  const { compileString } = await compiler
  return compileString(await fsp.readFile(file, 'utf8'), {
    loadPaths: [join(cwd, 'node_modules')],
    url: pathToFileURL(file),
    syntax: file.endsWith('.sass') ? 'indented' : 'scss',
  }).css
}

async function loadSass(cwd: string): Promise<SassCompiler> {
  for (const name of ['sass', 'sass-embedded']) {
    const path = await resolvePath(name, { url: pathToFileURL(join(cwd, 'package.json')) }).catch(() => undefined)
    if (path) {
      const sass = await import(pathToFileURL(path).href)
      return sass.compileString ? sass : sass.default
    }
  }
  throw new Error('Compiling Sass stylesheets requires `sass` or `sass-embedded` to be installed.')
}
