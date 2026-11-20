import { readFile } from 'node:fs/promises'
import type { TsConfigResult } from 'get-tsconfig'
import { relative } from 'pathe'
import type ts from 'typescript'

import { contentCache } from './cache.ts'
import { createTscEngine } from './engine.ts'
import type { DeclarationEngine, DeclarationProject, EngineDiagnostic, ProjectOptions, SourceFileCache } from './engine.ts'
import { isModuleFile, writeDeclarationPaths } from './tsconfig.ts'

export type { SourceFileCache } from './engine.ts'

export interface DeclarationProgramOptions {
  cwd: string
  tsconfig: TsConfigResult | undefined
  /** `paths` added to the tsconfig's. */
  paths: Record<string, string[]>
  /** Keeps the results of each `emit` without errors under this name in the module's cache, see `contentCache`. */
  cache?: string
  /** The compiler, the module's own TypeScript by default. */
  engine?: DeclarationEngine
  /** Parsed declaration files shared with other programs given the same map, without `engine`. See `TscEngineOptions`. */
  sourceFiles?: SourceFileCache
}

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
export async function createDeclarationProgram({ cwd, tsconfig, paths, cache, engine, sourceFiles }: DeclarationProgramOptions, roots: string[]): Promise<DeclarationProgram> {
  const declaration = await writeDeclarationPaths(cwd, tsconfig, paths)
  const options: ProjectOptions = {
    tsconfig: tsconfig?.path,
    include: file => isModuleFile(file, cwd),
    roots: [...roots, ...declaration.ambient ? [declaration.ambient] : []],
    compilerOptions: {
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
    },
  }
  const tsc = createTscEngine({ sourceFiles })
  // The module's own TypeScript parses the tsconfig and resolves specifiers for every engine, so
  // that a cached emit needs no other compiler.
  const base = await tsc.open(options)
  let project: Promise<DeclarationProject> | undefined
  const compiler = engine ?? tsc
  const emitter = () => project ??= engine ? engine.open(options) : Promise.resolve(base)

  const declarationProgram: DeclarationProgram = {
    resolve: base.resolve,
    async emit(files) {
      const { declarations, diagnostics, skipped } = await (await emitter()).emit(files)
      for (const file of files) {
        const text = declarations.get(file)
        if (text !== undefined) {
          declarations.set(file, await restoreImports(text, file, await readFile(file, 'utf8')))
        }
      }
      return {
        declarations,
        errors: [
          ...new Set(diagnostics.filter(diagnostic => diagnostic.category === 'error').map(diagnostic => formatDiagnostic(diagnostic, cwd))),
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
      const { options, rootNames } = base.key
      const stored = contentCache<Array<[string, string]>>(cwd, cache, { format: 4, engine: compiler.name, version: compiler.version, cwd, options, rootNames, files })
      const hit = await stored.read()
      if (hit) {
        return { declarations: new Map(hit), errors: [] }
      }
      const result = await declarationProgram.emit(files)
      if (!result.errors.length) {
        await stored.write([...result.declarations], await (await emitter()).inputs())
      }
      return result
    },
  }
}

/** A diagnostic formatted as tsc prints it, with its file relative to `cwd`. */
function formatDiagnostic(diagnostic: EngineDiagnostic, cwd: string): string {
  const prefix = `error TS${diagnostic.code}: ${diagnostic.message}`
  return diagnostic.file && diagnostic.line !== undefined ? `${relative(cwd, diagnostic.file)}(${diagnostic.line},${diagnostic.column}): ${prefix}` : prefix
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
  const referenced: Array<[name: string, node: ts.Node]> = []
  const declared: Array<[name: string, scope: ts.Node, outside?: ts.Node]> = []
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
      const conditional = ts.isInferTypeNode(node.parent) ? ts.findAncestor(node.parent, ts.isConditionalTypeNode) : undefined
      declared.push(conditional ? [node.name.text, conditional, conditional.falseType] : [node.name.text, node.parent])
    }
    if ((ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      declared.push([node.name.text, ts.findAncestor(node.parent, ancestor => ts.isModuleBlock(ancestor) || ts.isSourceFile(ancestor))!])
    }
    ts.forEachChild(node, visit)
  }
  visit(emitted)
  const within = (node: ts.Node, scope: ts.Node) => !!ts.findAncestor(node, ancestor => ancestor === scope)
  const missing = [...new Set(referenced.filter(([name, node]) => !declared.some(([local, scope, outside]) => local === name && within(node, scope) && !(outside && within(node, outside)))).map(([name]) => name))]
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
