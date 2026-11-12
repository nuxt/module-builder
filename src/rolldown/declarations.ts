import type { TsConfigResult } from 'get-tsconfig'
import { dirname, relative } from 'pathe'
import type ts from 'typescript'

import { declarationPaths, projectFiles, tsconfigPaths, writeAmbientModules, writeServerRoutesStub } from './tsconfig.ts'
import type { DeclarationPaths } from './tsconfig.ts'

export interface DeclarationProgramOptions {
  cwd: string
  tsconfig: TsConfigResult | undefined
  /** `paths` added to the tsconfig's. */
  paths: Record<string, string[]>
}

interface DeclarationEmit {
  /** Declarations keyed by source path. */
  declarations: Map<string, string>
  /** Diagnostics that prevent correct declarations: syntax errors, emit errors and skipped files. */
  errors: string[]
  /** Other type errors in the emitted files, which do not affect their declarations. */
  warnings: string[]
}

export interface DeclarationProgram {
  paths: DeclarationPaths
  emit: (files: string[]) => Promise<DeclarationEmit>
}

/**
 * A declaration-only program over every file of the tsconfig plus `roots`, so ambient
 * declarations apply and inferred types are named by package.
 */
export async function createDeclarationProgram({ cwd, tsconfig, paths }: DeclarationProgramOptions, roots: string[]): Promise<DeclarationProgram> {
  const { default: ts } = await import('typescript')
  const classifier = import('vue-sfc-transformer/core')
  const parsed = tsconfig ? ts.getParsedCommandLineOfConfigFile(tsconfig.path, {}, configHost(ts)) : undefined
  const declaration = declarationPaths({ ...tsconfigPaths(tsconfig), ...paths }, cwd)
  const rootNames = new Set([...projectFiles(parsed, cwd), ...roots])
  await writeServerRoutesStub(cwd)
  if (declaration.ambient.length) {
    rootNames.add(await writeAmbientModules(cwd, declaration.ambient))
  }

  const options: ts.CompilerOptions = {
    ...parsed?.options,
    allowJs: true,
    paths: declaration.paths,
    pathsBasePath: undefined,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    noEmit: false,
    isolatedDeclarations: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    outDir: undefined,
    declarationDir: undefined,
  }
  let program: ts.Program | undefined

  return {
    paths: declaration,
    async emit(files) {
      program ??= ts.createProgram({ rootNames: [...rootNames], options, projectReferences: parsed?.projectReferences })
      const { isDeclarationEmitDiagnostic } = await classifier
      const declarations = new Map<string, string>()
      const errors: ts.Diagnostic[] = []
      const warnings: ts.Diagnostic[] = []
      const skipped: string[] = []
      for (const file of files) {
        const source = program.getSourceFile(file)
        if (!source) {
          skipped.push(file)
          continue
        }
        const reported = errors.length
        errors.push(...program.getSyntacticDiagnostics(source))
        for (const diagnostic of program.getSemanticDiagnostics(source)) {
          (isDeclarationEmitDiagnostic({ code: diagnostic.code, kind: 'semantic' }) ? errors : warnings).push(diagnostic)
        }
        const result = program.emit(source, (_name, text, _bom, _error, sources) => {
          const emitted = sources?.[0]?.fileName
          if (emitted) {
            declarations.set(emitted, text)
          }
        }, undefined, true)
        errors.push(...result.diagnostics)
        if ((result.emitSkipped || !declarations.has(file)) && errors.length === reported) {
          skipped.push(file)
        }
      }
      const isError = (diagnostic: ts.Diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
      return {
        declarations,
        errors: [
          ...new Set(formatDiagnostics(ts, errors.filter(isError), cwd)),
          ...skipped.map(file => `${relative(cwd, file)}: no declaration was emitted`),
        ],
        warnings: [...new Set(formatDiagnostics(ts, warnings.filter(isError), cwd))],
      }
    },
  }
}

function configHost(ts: typeof import('typescript')): ts.ParseConfigFileHost {
  return {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  }
}

function formatDiagnostics(ts: typeof import('typescript'), diagnostics: ts.Diagnostic[], cwd: string) {
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (!diagnostic.file || diagnostic.start === undefined) {
      return `error TS${diagnostic.code}: ${message}`
    }
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${relative(cwd, diagnostic.file.fileName)}(${line + 1},${character + 1}): error TS${diagnostic.code}: ${message}`
  })
}

const UNNAMEABLE_TYPE_RE = /^(.+?)\((\d+),\d+\): error TS\d+: (.*cannot be named.*)$/

/** The error for declaration diagnostics, carrying them so concurrent ones can be merged. */
export class DeclarationError extends Error {
  readonly diagnostics: string[]
  constructor(message: string, diagnostics: string[]) {
    super(message)
    this.diagnostics = diagnostics
  }
}

/**
 * The error for declaration diagnostics. Exports whose inferred type cannot be named
 * (TS2742 and relatives) are listed with the file and line to annotate.
 */
export function declarationError(diagnostics: string[]): DeclarationError {
  const unnameable = diagnostics.flatMap((diagnostic) => {
    const match = diagnostic.match(UNNAMEABLE_TYPE_RE)
    if (!match) {
      return []
    }
    const [, file, line, text] = match
    const name = text!.match(/^(?:The inferred type of|Exported variable) '([^']+)'/)?.[1]
    return [`- ${name ? `\`${name}\` in ` : ''}${file}:${line}`]
  })
  return new DeclarationError([
    ...diagnostics,
    ...unnameable.length
      ? [
          '',
          'These exports have an inferred type from a package the module cannot reference by name, such as a dependency of a dependency or another version of a package the module uses. Give each an explicit type annotation, such as `ReturnType<typeof fn>` for a value produced by an imported `fn`:',
          ...unnameable,
        ]
      : [],
  ].join('\n'), diagnostics)
}

/** The relative specifier from the directory of `from` to `to`. */
export function relativeSpecifier(from: string, to: string): string {
  const path = relative(dirname(from), to)
  return path.startsWith('.') ? path : `./${path}`
}
