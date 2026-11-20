import { createRequire } from 'node:module'
import type ts from 'typescript'

type DeclarationEngineName = 'tsc' | 'tsgo' | 'tsrs'

export interface EngineDiagnostic {
  code: number
  category: 'error' | 'warning' | 'suggestion' | 'message'
  /** Absolute path of the file it is reported in. */
  file?: string
  /** 1-based. */
  line?: number
  /** 1-based. */
  column?: number
  /** The message, with any chain flattened as tsc prints it. */
  message: string
}

interface EngineEmit {
  /** Declarations keyed by source path. */
  declarations: Map<string, string>
  /** The syntax and emit diagnostics of the requested files, in order. */
  diagnostics: EngineDiagnostic[]
  /** Requested files that are not in the program, or got no declaration and no diagnostic. */
  skipped: string[]
}

export interface ProjectOptions {
  /** The tsconfig whose files and compiler options the program starts from. */
  tsconfig: string | undefined
  /** Which files of the tsconfig become roots. */
  include: (file: string) => boolean
  /** Roots after those of the tsconfig. */
  roots: string[]
  /** Compiler options that replace the tsconfig's. */
  compilerOptions: Record<string, unknown>
}

export interface DeclarationProject {
  emit: (files: string[]) => Promise<EngineEmit>
  /** Every file the program read, with the text it read where known. */
  inputs: () => Promise<Map<string, string | undefined>>
}

/** A compiler that generates the declarations of TypeScript sources. */
export interface DeclarationEngine {
  readonly name: DeclarationEngineName
  /** The compiler's version. */
  readonly version: string
  /** A declaration-only program over the files `include` keeps of the tsconfig, then `roots`. */
  open: (options: ProjectOptions) => Promise<DeclarationProject>
  /** Releases what the engine keeps between programs. */
  close: () => Promise<void>
}

interface TscProject extends DeclarationProject {
  /** What the program is created from besides the files it reads. */
  readonly key: { options: ts.CompilerOptions, rootNames: string[] }
  /** The file `specifier` resolves to from `importer`, with the program's options. */
  resolve: (specifier: string, importer: string) => string | undefined
}

export interface TscEngine extends DeclarationEngine {
  /** Parses the tsconfig; the program is created on first use. */
  open: (options: ProjectOptions) => Promise<TscProject>
}

export type SourceFileCache = Map<string, ts.SourceFile>

export interface TscEngineOptions {
  /**
   * Parsed declaration files that the programs of engines given the same map share. A declaration
   * file (`.d.ts`) parses and binds the same under every option besides `languageVersion`,
   * `impliedNodeFormat`, `jsDocParsingMode` and module detection, so programs over different
   * projects can share it. Other files are parsed by each program.
   */
  sourceFiles?: SourceFileCache
}

/** The module's own TypeScript, with its JavaScript API. */
export function createTscEngine({ sourceFiles }: TscEngineOptions = {}): TscEngine {
  return {
    name: 'tsc',
    get version() {
      return (createRequire(import.meta.url)('typescript/package.json') as { version: string }).version
    },
    async open({ tsconfig, include, roots, compilerOptions }) {
      const { default: ts } = await import('typescript')
      const parsed = tsconfig ? ts.getParsedCommandLineOfConfigFile(tsconfig, {}, configHost(ts)) : undefined
      const rootNames = [...new Set([...(parsed?.fileNames ?? []).filter(include), ...roots])]
      const options: ts.CompilerOptions = { ...parsed?.options, ...compilerOptions as ts.CompilerOptions }
      let program: ts.Program | undefined
      const createProgram = () => program ??= ts.createProgram({ rootNames, options, host: sourceFiles && sharingHost(ts, options, sourceFiles) })
      return {
        key: { options, rootNames },
        resolve: (specifier, importer) => ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule?.resolvedFileName,
        async inputs() {
          return new Map(createProgram().getSourceFiles().map(file => [file.fileName, file.text]))
        },
        async emit(files) {
          const program = createProgram()
          const declarations = new Map<string, string>()
          const diagnostics: ts.Diagnostic[] = []
          const skipped: string[] = []
          for (const file of files) {
            const source = program.getSourceFile(file)
            if (!source) {
              skipped.push(file)
              continue
            }
            const reported = diagnostics.length
            diagnostics.push(...program.getSyntacticDiagnostics(source))
            const result = program.emit(source, (_name, text, _bom, _error, sources) => {
              const emitted = sources?.[0]?.fileName
              if (emitted) {
                declarations.set(emitted, text)
              }
            }, undefined, true)
            diagnostics.push(...result.diagnostics)
            if ((result.emitSkipped || !declarations.has(file)) && diagnostics.length === reported) {
              skipped.push(file)
            }
          }
          return { declarations, diagnostics: diagnostics.map(diagnostic => engineDiagnostic(ts, diagnostic)), skipped }
        },
      }
    },
    async close() {},
  }
}

const CATEGORIES = ['warning', 'error', 'suggestion', 'message'] as const

function engineDiagnostic(ts: typeof import('typescript'), diagnostic: ts.Diagnostic): EngineDiagnostic {
  const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined
  return {
    code: diagnostic.code,
    category: CATEGORIES[diagnostic.category],
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ...position && { file: diagnostic.file!.fileName, line: position.line + 1, column: position.character + 1 },
  }
}

const DECLARATION_FILE_RE = /\.d\.(?:[^/]+\.)?[cm]?ts$/

function sharingHost(ts: typeof import('typescript'), options: ts.CompilerOptions, sourceFiles: SourceFileCache): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (shouldCreateNewSourceFile || !DECLARATION_FILE_RE.test(fileName)) {
      return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }
    const { languageVersion, impliedNodeFormat, jsDocParsingMode, setExternalModuleIndicator } = typeof languageVersionOrOptions === 'object' ? languageVersionOrOptions : { languageVersion: languageVersionOrOptions } as ts.CreateSourceFileOptions
    const key = [fileName, languageVersion, impliedNodeFormat, jsDocParsingMode].join('\0')
    const cached = sourceFiles.get(key)
    if (cached && cached.text === host.readFile(fileName) && sameModuleIndicator(cached, setExternalModuleIndicator)) {
      return cached
    }
    const sourceFile = getSourceFile(fileName, languageVersionOrOptions, onError)
    if (sourceFile) {
      sourceFiles.set(key, sourceFile)
    }
    return sourceFile
  }
  return host
}

/** Whether `setExternalModuleIndicator` of the requesting program decides as the one that parsed `file` did. */
function sameModuleIndicator(file: ts.SourceFile, setExternalModuleIndicator: ((file: ts.SourceFile) => void) | undefined) {
  if (!setExternalModuleIndicator) {
    return true
  }
  const probe = Object.create(file) as ts.SourceFile & { externalModuleIndicator?: unknown }
  setExternalModuleIndicator(probe)
  return probe.externalModuleIndicator === (file as typeof probe).externalModuleIndicator
}

function configHost(ts: typeof import('typescript')): ts.ParseConfigFileHost {
  return {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  }
}
