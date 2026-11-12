import { readFile } from 'node:fs/promises'
import { relative } from 'pathe'
import type { DeclarationDiagnostic, DtsCache, Transform } from 'vue-sfc-transformer/core'

export interface VueOptions {
  /** Extra key for the declaration cache, for inputs the cache cannot see, such as generated type augmentations. */
  cacheVersion?: string
  /** The declaration cache, or `false` to disable it. Defaults to `node_modules/.cache/vue-sfc-dts`. */
  cache?: DtsCache | false
  /** Also emit each declaration as `<name>.vue.d.ts`, the file name older toolchains resolve. Defaults to `true`. */
  emitLegacyDeclarationAlias?: boolean
}

export interface VueDeclarationOptions extends VueOptions {
  cwd: string
  /** The tsconfig to emit declarations from. */
  tsconfig?: string
}

interface DeclarationMessage {
  /** The source file the diagnostic is reported in, if any. */
  file?: string
  /** The diagnostic, formatted like tsc's. */
  message: string
}

export interface VueDeclarations {
  /** Declarations keyed by the path next to their source: `Foo.d.vue.ts` and, by default, `Foo.vue.d.ts`; `foo.d.ts` for a script. */
  declarations: Map<string, string>
  /** Diagnostics that prevent correct declarations. */
  errors: DeclarationMessage[]
  /** Other type errors in the sources, which do not affect their declarations. */
  warnings: DeclarationMessage[]
}

/** Transforms `.vue` files into their runtime form with TypeScript stripped, keyed by source path. */
export async function transformVueRuntime(files: string[], transform?: Transform): Promise<Map<string, string>> {
  const { transformVueSfc } = await import('vue-sfc-transformer/core')
  return new Map(await Promise.all(files.map(async (id) => {
    const { code } = await transformVueSfc(await readFile(id, 'utf8'), id, { transform })
    return [id, code] as const
  })))
}

/**
 * Emits declarations for `.vue` files and TypeScript sources from one program over
 * `tsconfig`, so scripts can import types from single-file components.
 */
export async function emitDeclarations(files: string[], options: VueDeclarationOptions): Promise<VueDeclarations> {
  const { emitVueDeclarations, isDeclarationEmitDiagnostic } = await import('vue-sfc-transformer/core')
  const sources = await Promise.all(files.map(async id => ({ id, source: await readFile(id, 'utf8') })))
  const { files: declarations, diagnostics } = await emitVueDeclarations(sources, {
    cwd: options.cwd,
    tsconfig: options.tsconfig,
    cache: options.cache,
    cacheVersion: options.cacheVersion,
    emitLegacyDeclarationAlias: options.emitLegacyDeclarationAlias ?? true,
  })
  const errors = diagnostics.filter(diagnostic => diagnostic.category === 'error')
  const format = (diagnostic: DeclarationDiagnostic): DeclarationMessage => ({ file: diagnostic.file, message: formatDiagnostic(diagnostic, options.cwd) })
  return {
    declarations,
    errors: errors.filter(diagnostic => isDeclarationEmitDiagnostic(diagnostic)).map(format),
    warnings: errors.filter(diagnostic => !isDeclarationEmitDiagnostic(diagnostic)).map(format),
  }
}

/** The declaration emitted next to a source file. */
export function declarationPath(id: string) {
  return id.replace(/\.(vue|[cm]?ts|tsx)$/, (_, extension: string) => extension === 'vue' ? '.d.vue.ts' : extension === 'tsx' ? '.d.ts' : `.d.${extension}`)
}

function formatDiagnostic(diagnostic: DeclarationDiagnostic, cwd: string) {
  const location = diagnostic.file
    ? `${relative(cwd, diagnostic.file)}${diagnostic.line === undefined ? '' : `(${diagnostic.line},${diagnostic.column})`}: `
    : ''
  return `${location}error TS${diagnostic.code}: ${diagnostic.message}`
}
