import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { consola } from 'consola'
import type { TsConfigResult } from 'get-tsconfig'
import { dirname, join, normalize, relative, resolve } from 'pathe'

import { createDeclarationProgram } from '../transpile/declarations.ts'
import { DECLARATION_RE, probe, RELATIVE_RE, rewriteSpecifiers, SCRIPT_RE } from '../transpile/resolve.ts'
import { isModuleFile } from '../transpile/tsconfig.ts'
import { relativeSpecifier } from '../utils.ts'
import { loadOxc } from './loader.ts'
import { hasIsolatedDeclarations } from './tsconfig.ts'
import { writeSourceTypes } from './types.ts'

const NUXT_DIR_RE = /^\.nuxt(?:\/|$)/

function declarationFile(cwd: string, dir: string, file: string) {
  return join(dir, relative(cwd, file)).replace(/\.([cm]?)[jt]sx?$/, (_, format: string) => `.d.${format}ts`)
}

/**
 * The `paths` that resolve the module's own package name to `types.d.mts` in `dir`, and the
 * subpaths of its other bundled entries to their declarations there. Subpaths into a runtime
 * directory, or with a wildcard, are left out.
 */
export function moduleDeclarationPaths(cwd: string, dir: string, name: string, selfPaths: Record<string, string[]>, runtimeDirs: string[]): Record<string, string[]> {
  const paths: Record<string, string[]> = { [name]: [join(dir, 'types.d.mts')] }
  for (const [alias, [target]] of Object.entries(selfPaths)) {
    const file = target && !alias.includes('*') && alias !== name ? probe(target) : undefined
    if (file && SCRIPT_RE.test(file) && !runtimeDirs.some(runtimeDir => !relative(runtimeDir, file).startsWith('..'))) {
      paths[alias] = [declarationFile(cwd, dir, file)]
    }
  }
  return paths
}

export interface ModuleDeclarationOptions {
  /** The project that includes the module entry. */
  tsconfig: TsConfigResult | undefined
  entry: string
  /** The bundled entries, the module entry included. */
  roots: string[]
  /** `paths` added to the tsconfig's. */
  paths: Record<string, string[]>
}

/**
 * Writes into `dir` the declarations of the module code that `roots` reach, and a
 * `types.d.mts` over them with the module's type augmentations. Declaration errors are
 * reported as a warning, and the other declarations are written.
 */
export async function writeModuleDeclarations(cwd: string, dir: string, { tsconfig, entry, roots, paths }: ModuleDeclarationOptions): Promise<void> {
  await writeSourceTypes(dir, entry, join(dir, relative(cwd, entry)))
  const isModuleCode = (file: string) => SCRIPT_RE.test(file) && !DECLARATION_RE.test(file) && isModuleFile(file, cwd) && !NUXT_DIR_RE.test(relative(cwd, file))
  const program = await createDeclarationProgram({ cwd, tsconfig, paths }, roots)
  const sources = program.sources().filter(isModuleCode)
  const { declarations, errors } = (hasIsolatedDeclarations(tsconfig) && await isolatedDeclarations(sources, cwd))
    || await program.emit(sources)
  const emitted = new Map([...declarations.keys()].map(source => [normalize(source), declarationFile(cwd, dir, source)]))
  await Promise.all([...declarations].map(async ([source, text]) => {
    const output = emitted.get(normalize(source))!
    const code = rewriteSpecifiers(text, (specifier) => {
      const isRelative = RELATIVE_RE.test(specifier)
      const target = (isRelative ? probe(resolve(dirname(source), specifier)) : undefined) ?? program.resolve(specifier, source)
      const declaration = target && emitted.get(normalize(target))
      if (declaration) {
        return relativeSpecifier(output, declaration).replace(/\.d\.([cm]?)ts$/, '.$1js')
      }
      return isRelative && target ? relativeSpecifier(output, target).replace(/\.d\.([cm]?)ts$/, '.$1js') : undefined
    })
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, code)
  }))
  if (errors.length) {
    consola.warn([
      `Declarations of module code for the module's own app, server and shared type checks could not be generated for every file. The build reports the same errors:`,
      ...errors,
    ].join('\n'))
  }
}

async function isolatedDeclarations(files: string[], cwd: string) {
  const oxc = loadOxc()
  if (!oxc) {
    return
  }
  const declarations = new Map<string, string>()
  const errors: string[] = []
  for (const file of files) {
    const result = await oxc.transform(file, await readFile(file, 'utf8'), { typescript: { declaration: {} } } as never) as { declaration?: string, errors: Array<{ message: string }> }
    if (result.declaration !== undefined) {
      declarations.set(file, result.declaration)
    }
    errors.push(...result.errors.map(error => `${relative(cwd, file)}: ${error.message}`))
  }
  return { declarations, errors }
}
