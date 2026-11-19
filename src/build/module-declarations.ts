import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { TsConfigResult } from 'get-tsconfig'
import { dirname, join, normalize, relative, resolve } from 'pathe'

import { warnings } from '../diagnostics.ts'
import { createDeclarationProgram } from '../transpile/declarations.ts'
import { moduleSpecifiers, rewriteSpecifiers } from '../transpile/specifiers.ts'
import { hasIsolatedDeclarations, isModuleFile } from '../transpile/tsconfig.ts'
import { isInside, isSourceScript, probe, RELATIVE_RE, relativeSpecifier, SCRIPT_RE } from '../utils.ts'
import { loadOxc } from './loader.ts'
import { writeSourceTypes } from './types.ts'

const NUXT_DIR_RE = /^\.nuxt(?:\/|$)/

function declarationFile(cwd: string, dir: string, file: string) {
  return join(dir, relative(cwd, file)).replace(/\.([cm]?)[jt]sx?$/, (_, format: string) => `.d.${format}ts`)
}

/**
 * The `paths` that resolve the module's own package name to `types.d.mts` in `dir`, and the
 * subpaths of its other bundled entries to their declarations there, with the `sources` of
 * those subpaths. Subpaths into a runtime directory, or with a wildcard, are left out.
 */
export function moduleDeclarationPaths(cwd: string, dir: string, name: string, selfPaths: Record<string, string[]>, runtimeDirs: string[]): { paths: Record<string, string[]>, sources: string[] } {
  const paths: Record<string, string[]> = { [name]: [join(dir, 'types.d.mts')] }
  const sources: string[] = []
  for (const [alias, [target]] of Object.entries(selfPaths)) {
    const file = target && !alias.includes('*') && alias !== name ? probe(target) : undefined
    if (file && SCRIPT_RE.test(file) && !runtimeDirs.some(runtimeDir => isInside(runtimeDir, file))) {
      paths[alias] = [declarationFile(cwd, dir, file)]
      sources.push(file)
    }
  }
  return { paths, sources }
}

export interface ModuleDeclarationOptions {
  /** The project that includes the module entry. */
  tsconfig: TsConfigResult | undefined
  entry: string
  /** The bundled entries, the module entry included. */
  roots: string[]
  /** `paths` added to the tsconfig's. */
  paths: Record<string, string[]>
  /** A declaration file the program lists so that the module's dependencies resolve from the module root, see `writeDependencyImports`. */
  imports?: string
}

/**
 * Writes into `dir` the declarations of the module code that `roots` reach through their
 * declarations, and a `types.d.mts` over them with the module's type augmentations.
 * Declaration errors are reported as a warning, and the other declarations are written.
 */
export async function writeModuleDeclarations(cwd: string, dir: string, { tsconfig, entry, roots, paths, imports }: ModuleDeclarationOptions): Promise<void> {
  await writeSourceTypes(dir, entry, join(dir, relative(cwd, entry)))
  const isModuleCode = (file: string) => isSourceScript(file) && isModuleFile(file, cwd) && !NUXT_DIR_RE.test(relative(cwd, file))
  const program = await createDeclarationProgram({ cwd, tsconfig, paths }, [...roots, ...imports ? [imports] : []])
  const oxc = hasIsolatedDeclarations(tsconfig) ? loadOxc() : null
  const targetOf = (specifier: string, source: string) => (RELATIVE_RE.test(specifier) ? probe(resolve(dirname(source), specifier)) : undefined) ?? program.resolve(specifier, source)
  const declarations = new Map<string, string>()
  const errors: string[] = []
  let pending = [...new Set(roots.map(root => normalize(root)))].filter(isModuleCode)
  const seen = new Set(pending)
  while (pending.length) {
    const result = oxc ? await isolatedDeclarations(oxc, pending, cwd) : await program.emit(pending)
    errors.push(...result.errors)
    pending = []
    for (const [source, text] of result.declarations) {
      declarations.set(normalize(source), text)
      for (const { specifier } of moduleSpecifiers(text)) {
        const target = targetOf(specifier, source)
        const file = target && normalize(target)
        if (file && isModuleCode(file) && !seen.has(file)) {
          seen.add(file)
          pending.push(file)
        }
      }
    }
  }
  const emitted = new Map([...declarations.keys()].map(source => [source, declarationFile(cwd, dir, source)]))
  await Promise.all([...declarations].map(async ([source, text]) => {
    const output = emitted.get(source)!
    const code = rewriteSpecifiers(text, (specifier) => {
      const isRelative = RELATIVE_RE.test(specifier)
      const target = targetOf(specifier, source)
      const declaration = target && emitted.get(normalize(target))
      if (declaration) {
        return relativeSpecifier(output, declaration).replace(/\.d\.([cm]?)ts$/, '.$1js')
      }
      return isRelative && target ? relativeSpecifier(output, target).replace(/\.d\.([cm]?)ts$/, '.$1js') : undefined
    }, output)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, code)
  }))
  if (errors.length) {
    const sources = errors.flatMap((error) => {
      const [, file, line, column] = error.match(ERROR_LOCATION_RE) ?? []
      return file ? [`${resolve(cwd, file)}${line ? `:${line}:${column}` : ''}`] : []
    })
    warnings.NUXT_MB_B0204({ errors, sources: [...new Set(sources)] })
  }
}

const ERROR_LOCATION_RE = /^([^\s():][^():]*)(?:\((\d+),(\d+)\))?: /

async function isolatedDeclarations(oxc: NonNullable<ReturnType<typeof loadOxc>>, files: string[], cwd: string) {
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
