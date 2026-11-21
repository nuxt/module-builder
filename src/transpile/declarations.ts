import type { TsConfigResult } from 'get-tsconfig'
import { relative } from 'pathe'
import type ts from 'typescript'

import { contentCache } from './cache.ts'
import { projectFiles, writeDeclarationPaths } from './tsconfig.ts'

export interface DeclarationProgramOptions {
  cwd: string
  tsconfig: TsConfigResult | undefined
  /** `paths` added to the tsconfig's. */
  paths: Record<string, string[]>
  /** Keeps the results of each `emit` without errors under this name in the module's cache, see `contentCache`. */
  cache?: string
  /**
   * Parsed declaration files that the programs given the same map share. A declaration file
   * (`.d.ts`) parses and binds the same under every option besides `languageVersion`,
   * `impliedNodeFormat`, `jsDocParsingMode` and module detection, so programs over different
   * projects can share it. Other files are parsed by each program.
   */
  sourceFiles?: SourceFileCache
}

export type SourceFileCache = Map<string, ts.SourceFile>

interface DeclarationEmit {
  /** Declarations keyed by source path. */
  declarations: Map<string, string>
  /** Diagnostics that prevent correct declarations: syntax errors, emit errors and skipped files. */
  errors: string[]
}

export interface DeclarationProgram {
  emit: (files: string[]) => Promise<DeclarationEmit>
  /** The file `specifier` resolves to from `importer`, with the program's options. */
  resolve: (specifier: string, importer: string) => string | undefined
}

/**
 * A declaration-only program over every file of the tsconfig plus `roots`, so ambient
 * declarations apply and inferred types are named by package. The tsconfig's `references` are
 * left out, so files of referenced projects are read from source rather than from their output.
 * It doesn't type check (`noCheck`): only syntax and declaration emit errors are reported.
 */
export async function createDeclarationProgram({ cwd, tsconfig, paths, cache, sourceFiles }: DeclarationProgramOptions, roots: string[]): Promise<DeclarationProgram> {
  const { default: ts } = await import('typescript')
  const parsed = tsconfig ? ts.getParsedCommandLineOfConfigFile(tsconfig.path, {}, configHost(ts)) : undefined
  const declaration = await writeDeclarationPaths(cwd, tsconfig, paths)
  const rootNames = new Set([...projectFiles(parsed, cwd), ...roots, ...declaration.ambient ? [declaration.ambient] : []])

  const options: ts.CompilerOptions = {
    ...parsed?.options,
    allowJs: true,
    allowImportingTsExtensions: true,
    paths: declaration.paths,
    pathsBasePath: undefined,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    noEmit: false,
    isolatedDeclarations: false,
    noCheck: true,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    outDir: undefined,
    declarationDir: undefined,
  }
  let program: ts.Program | undefined
  const createProgram = () => program ??= ts.createProgram({ rootNames: [...rootNames], options, host: sourceFiles && sharingHost(ts, options, sourceFiles) })

  const declarationProgram: DeclarationProgram = {
    resolve: (specifier, importer) => ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule?.resolvedFileName,
    async emit(files) {
      const program = createProgram()
      const declarations = new Map<string, string>()
      const errors: ts.Diagnostic[] = []
      const skipped: string[] = []
      for (const file of files) {
        const source = program.getSourceFile(file)
        if (!source) {
          skipped.push(file)
          continue
        }
        const reported = errors.length
        errors.push(...program.getSyntacticDiagnostics(source))
        const result = program.emit(source, (_name, text, _bom, _error, sources) => {
          const emitted = sources?.[0]?.fileName
          if (emitted) {
            declarations.set(emitted, text)
          }
        }, undefined, true)
        const text = declarations.get(file)
        if (text !== undefined) {
          declarations.set(file, await restoreImports(text, file, source.text))
        }
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
      }
    },
  }
  if (!cache) {
    return declarationProgram
  }
  return {
    ...declarationProgram,
    async emit(files) {
      const stored = contentCache<Array<[string, string]>>(cwd, cache, { format: 3, typescript: ts.version, cwd, options, rootNames: [...rootNames], files })
      const hit = await stored.read()
      if (hit) {
        return { declarations: new Map(hit), errors: [] }
      }
      const result = await declarationProgram.emit(files)
      if (!result.errors.length) {
        await stored.write([...result.declarations], new Map(program!.getSourceFiles().map(file => [file.fileName, file.text])))
      }
      return result
    },
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

const SFC_SCRIPT_RE = /<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\b[^>]*>/gi

/**
 * `declaration` with the imports of `source` (`code`, the file's contents) that it refers to by
 * name but no longer imports. TypeScript leaves out a named type import from a module declared
 * as `declare module '#build/*'` while keeping the references to it, and the app that installs
 * the module resolves the alias.
 */
export async function restoreImports(declaration: string, source: string, code: string): Promise<string> {
  const { default: ts } = await import('typescript')
  const script = source.endsWith('.vue') ? [...code.matchAll(SFC_SCRIPT_RE)].map(([, content]) => content).join('\n') : code
  const emitted = ts.createSourceFile('declaration.d.ts', declaration, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const known = new Set<string>()
  const referenced: Array<[name: string, node: ts.Node]> = []
  const typeParameters: Array<[name: string, scope: ts.Node]> = []
  const visit = (node: ts.Node) => {
    if ((ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node) || ts.isExpressionWithTypeArguments(node)) && !ts.isImportTypeNode(node)) {
      let name: ts.Node = ts.isTypeReferenceNode(node) ? node.typeName : ts.isTypeQueryNode(node) ? node.exprName : node.expression
      while (ts.isQualifiedName(name) || ts.isPropertyAccessExpression(name)) {
        name = ts.isQualifiedName(name) ? name.left : name.expression
      }
      if (ts.isIdentifier(name)) {
        referenced.push([name.text, node])
      }
    }
    if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier) {
      referenced.push([(node.propertyName ?? node.name).text, node])
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      referenced.push([node.expression.text, node])
    }
    if (ts.isTypeParameterDeclaration(node)) {
      typeParameters.push([node.name.text, ts.isInferTypeNode(node.parent) ? ts.findAncestor(node.parent, ts.isConditionalTypeNode) ?? node.parent : node.parent])
    }
    if ((ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      known.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(emitted)
  const within = (node: ts.Node, scope: ts.Node) => !!ts.findAncestor(node, ancestor => ancestor === scope)
  const missing = [...new Set(referenced.filter(([name, node]) => !known.has(name) && !typeParameters.some(([parameter, scope]) => parameter === name && within(node, scope))).map(([name]) => name))]
  if (!missing.length) {
    return declaration
  }
  const pending = new Set(missing)
  const imports: string[] = []
  for (const statement of ts.createSourceFile(source, script, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) {
      continue
    }
    const clause = statement.importClause
    const specifier = `'${statement.moduleSpecifier.text.replaceAll('\'', '\\\'')}'`
    const bindings = clause.namedBindings
    if (clause.name && pending.delete(clause.name.text)) {
      imports.push(`import type ${clause.name.text} from ${specifier};`)
    }
    if (bindings && ts.isNamespaceImport(bindings) && pending.delete(bindings.name.text)) {
      imports.push(`import type * as ${bindings.name.text} from ${specifier};`)
    }
    const named = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(element => pending.delete(element.name.text)) : []
    if (named.length) {
      imports.push(`import type { ${named.map(element => element.propertyName ? `${ts.isStringLiteral(element.propertyName) ? JSON.stringify(element.propertyName.text) : element.propertyName.text} as ${element.name.text}` : element.name.text).join(', ')} } from ${specifier};`)
    }
  }
  return imports.length ? `${imports.join('\n')}\n${declaration}` : declaration
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
