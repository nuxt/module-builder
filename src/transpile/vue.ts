import { readFile } from 'node:fs/promises'
import { relative } from 'pathe'
import type { DeclarationDiagnostic, Transform, VueDeclarationSession } from 'vue-sfc-transformer/core'

import type { TypeResolutionFs } from './tsconfig.ts'

interface VueDeclarationOptions {
  cwd: string
  /** The tsconfig to emit declarations from. */
  tsconfig?: string
  /** Extra key for the declaration cache, for inputs the cache cannot see, such as generated type augmentations. */
  cacheVersion: string
  /** Keeps the parsed sources of this call for the next one with the same session. */
  session?: VueDeclarationSession
}

interface DeclarationMessage {
  /** The source file the diagnostic is reported in, if any. */
  file?: string
  /** The diagnostic, formatted like tsc's. */
  message: string
}

export interface VueDeclarations {
  /** Declarations keyed by the path next to their source: `Foo.d.vue.ts` and `Foo.vue.d.ts`; `foo.d.ts` for a script. */
  declarations: Map<string, string>
  /** Diagnostics that prevent correct declarations. */
  errors: DeclarationMessage[]
}

/**
 * Transforms `.vue` files into their runtime form with TypeScript stripped, keyed by source
 * path. The types of script setup macros resolve through `fs` of the file, when it has one.
 */
export async function transformVueRuntime(files: string[], transform: Transform, fs: Map<string, TypeResolutionFs>): Promise<Map<string, string>> {
  const { transformVueSfc } = await import('vue-sfc-transformer/core')
  return new Map(await Promise.all(files.map(async (id) => {
    const { code } = await transformVueSfc(await readFile(id, 'utf8'), id, { transform, ...fs.has(id) && { script: { fs: fs.get(id) } } })
    return [id, code] as const
  })))
}

/** A session to pass to each {@link emitDeclarations} call for one program, such as on rebuilds under watch. */
export async function createDeclarationSession(): Promise<VueDeclarationSession> {
  const { createVueDeclarationSession } = await import('vue-sfc-transformer/core')
  return createVueDeclarationSession()
}

/**
 * Emits declarations for `.vue` files and TypeScript sources from one program over
 * `tsconfig`, so scripts can import types from single-file components. The program doesn't type
 * check: only syntax and declaration emit errors are reported.
 */
export async function emitDeclarations(files: string[], options: VueDeclarationOptions): Promise<VueDeclarations> {
  const { emitVueDeclarations, isDeclarationEmitDiagnostic } = await import('vue-sfc-transformer/core')
  const sources = await Promise.all(files.map(async id => ({ id, source: await readFile(id, 'utf8') })))
  const { files: declarations, diagnostics } = await emitVueDeclarations(sources, {
    cwd: options.cwd,
    tsconfig: options.tsconfig,
    cacheVersion: options.cacheVersion,
    emitLegacyDeclarationAlias: true,
    session: options.session,
    typeCheck: false,
  })
  const format = (diagnostic: DeclarationDiagnostic): DeclarationMessage => ({ file: diagnostic.file, message: formatDiagnostic(diagnostic, options.cwd) })
  return {
    declarations,
    errors: diagnostics.filter(diagnostic => diagnostic.category === 'error' && isDeclarationEmitDiagnostic(diagnostic)).map(format),
  }
}

/** The declaration emitted next to a source file. */
export function declarationPath(id: string): string {
  return id.replace(/\.(vue|[cm]?ts|tsx)$/, (_, extension: string) => extension === 'vue' ? '.d.vue.ts' : extension === 'tsx' ? '.d.ts' : `.d.${extension}`)
}

function formatDiagnostic(diagnostic: DeclarationDiagnostic, cwd: string) {
  const location = diagnostic.file
    ? `${relative(cwd, diagnostic.file)}${diagnostic.line === undefined ? '' : `(${diagnostic.line},${diagnostic.column})`}: `
    : ''
  return `${location}error TS${diagnostic.code}: ${diagnostic.message}`
}
