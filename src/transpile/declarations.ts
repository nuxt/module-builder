import { readFile } from 'node:fs/promises'
import type { TsConfigResult } from 'get-tsconfig'
import { relative } from 'pathe'
import type { ImportDeclaration, ImportSpecifier, ModuleExportName, TSQualifiedName } from '@oxc-project/types'

import { contentCache } from './cache.ts'
import { createTscEngine } from './engine.ts'
import type { DeclarationEngine, DeclarationProject, EngineDiagnostic, ProjectOptions, SourceFileCache } from './engine.ts'
import { parseModule, walk } from './oxc.ts'
import type { Node } from './oxc.ts'
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
  /** Which files of the tsconfig become roots: those of the module, see `isModuleFile`, by default. */
  include?: (file: string) => boolean
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
  /** Every file the program read, with the text it read where known. */
  inputs: () => Promise<Map<string, string | undefined>>
}

/**
 * A declaration-only program over every file of the tsconfig plus `roots`, so ambient
 * declarations apply and inferred types are named by package. The tsconfig's `references` are
 * left out, so files of referenced projects are read from source rather than from their output.
 * It doesn't type check (`noCheck`): only syntax and declaration emit errors are reported.
 */
export async function createDeclarationProgram({ cwd, tsconfig, paths, cache, engine, include = file => isModuleFile(file, cwd), sourceFiles }: DeclarationProgramOptions, roots: string[]): Promise<DeclarationProgram> {
  const declaration = await writeDeclarationPaths(cwd, tsconfig, paths)
  const options: ProjectOptions = {
    tsconfig: tsconfig?.path,
    include,
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
    inputs: async () => (await emitter()).inputs(),
    async emit(files) {
      const { declarations, diagnostics } = await (await emitter()).emit(files)
      for (const file of files) {
        const text = declarations.get(file)
        if (text !== undefined) {
          declarations.set(file, await restoreImports(text, file, await readFile(file, 'utf8')))
        }
      }
      const reported = diagnostics.filter(isReported)
      return {
        declarations,
        errors: [
          ...new Set(reported.map(diagnostic => formatDiagnostic(diagnostic, cwd))),
          ...files.filter(file => !declarations.has(file) && !reported.some(diagnostic => diagnostic.file === file)).map(file => `${relative(cwd, file)}: no declaration was emitted`),
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
        await stored.write([...result.declarations], await declarationProgram.inputs())
      }
      return result
    },
  }
}

/** The codes TypeScript 7 reports where TypeScript 6 reports another code of the same class. */
export const REMAPPED_CODES: Record<number, number> = {
  2883: 2742,
  9013: 9007,
}

const MAPPER_RANGES: Array<[number, number]> = [[18065, 18073], [18075, 18079], [18081, 18083], [18099, 18099], [18118, 18123]]
const EMIT_CODES = new Set([2527, 4118, 5088, 7056])
const EMIT_RANGES: Array<[number, number]> = [[4000, 4103], [4106, 4108]]

export type DeclarationDiagnosticClass = 'portability' | 'isolated' | 'missing' | 'emit'

/**
 * The class of a declaration emit diagnostic: an inferred type that cannot be named, an
 * `isolatedDeclarations` error, a file that a content mapper could not map (so its declaration is
 * missing), or another error of declaration emit. Other codes, such as those of type errors, have
 * none.
 */
export function declarationDiagnosticClass(code: number): DeclarationDiagnosticClass | undefined {
  const original = REMAPPED_CODES[code] ?? code
  const within = (ranges: Array<[number, number]>) => ranges.some(([start, end]) => original >= start && original <= end)
  if (original === 2742) {
    return 'portability'
  }
  if (original >= 9005 && original <= 9039) {
    return 'isolated'
  }
  if (within(MAPPER_RANGES)) {
    return 'missing'
  }
  return EMIT_CODES.has(original) || within(EMIT_RANGES) ? 'emit' : undefined
}

/** Whether a diagnostic fails the build: an error of parsing, or of declaration emit. */
function isReported(diagnostic: EngineDiagnostic) {
  return diagnostic.category === 'error' && (diagnostic.kind === 'syntactic' || declarationDiagnosticClass(diagnostic.code) !== undefined)
}

/** A diagnostic formatted as tsc prints it, with its file relative to `cwd`. */
function formatDiagnostic(diagnostic: EngineDiagnostic, cwd: string): string {
  const prefix = `error TS${diagnostic.code}: ${diagnostic.message}`
  return diagnostic.file && diagnostic.line !== undefined ? `${relative(cwd, diagnostic.file)}(${diagnostic.line},${diagnostic.column}): ${prefix}` : prefix
}

const SFC_SCRIPT_RE = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script\b[^>]*>/gi
const SFC_LANG_RE = /\blang\s*=\s*["']?(\w+)/

/** The leftmost identifier of a qualified name or a property access, if it starts with one. */
function leftmostIdentifier(node: Node | null | undefined): string | undefined {
  while (node?.type === 'TSQualifiedName' || (node?.type === 'MemberExpression' && !node.computed)) {
    node = node.type === 'TSQualifiedName' ? node.left : node.object
  }
  return node?.type === 'Identifier' ? node.name : undefined
}

const moduleExportName = (name: ModuleExportName) => name.type === 'Literal' ? name.value : name.name

const DECLARED_TYPES = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'FunctionDeclaration', 'TSDeclareFunction', 'VariableDeclarator'])

/** The names that `declaration` refers to without declaring or importing them where it refers to them. */
function unboundNames(declaration: string): string[] {
  const parents = new Map<Node, Node>()
  const referenced: Array<[name: string, node: Node]> = []
  const declared: Array<[name: string, scope: Node]> = []
  const reference = (name: string | undefined, node: Node) => {
    if (name !== undefined) {
      referenced.push([name, node])
    }
  }
  const ancestor = (node: Node, matches: (node: Node) => boolean) => {
    for (let current = parents.get(node); current; current = parents.get(current)) {
      if (matches(current)) {
        return current
      }
    }
  }
  const block = (node: Node) => ancestor(node, ({ type }) => type === 'TSModuleBlock' || type === 'Program')!
  walk(parseModule(declaration, 'declaration.d.ts').program, (node, parent) => {
    if (parent) {
      parents.set(node, parent)
    }
    switch (node.type) {
      case 'TSTypeReference':
        reference(leftmostIdentifier(node.typeName), node)
        break
      case 'TSTypeQuery':
        reference(leftmostIdentifier(node.exprName), node)
        break
      case 'TSClassImplements':
      case 'TSInterfaceHeritage':
      case 'TSInstantiationExpression':
        reference(leftmostIdentifier(node.expression), node)
        break
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.superClass) {
          reference(leftmostIdentifier(node.superClass), node.superClass)
        }
        break
      case 'ExportNamedDeclaration':
        if (!node.source) {
          for (const specifier of node.specifiers) {
            reference(moduleExportName(specifier.local), specifier)
          }
        }
        break
      case 'ExportDefaultDeclaration':
        if (node.declaration.type === 'Identifier') {
          reference(node.declaration.name, node)
        }
        break
      case 'TSExportAssignment':
        if (node.expression.type === 'Identifier') {
          reference(node.expression.name, node)
        }
        break
      case 'TSTypeParameter':
        if (parent?.type === 'TSInferType') {
          const conditional = ancestor(parent, ({ type }) => type === 'TSConditionalType')
          for (const scope of conditional?.type === 'TSConditionalType' ? [conditional.extendsType, conditional.trueType] : [parent]) {
            declared.push([node.name.name, scope])
          }
        }
        else {
          declared.push([node.name.name, parents.get(parent!)!])
        }
        break
      case 'TSMappedType':
        declared.push([node.key.name, node])
        break
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        declared.push([node.local.name, block(node)])
        break
      case 'TSModuleDeclaration':
        for (let id: Node = node.id; ; id = (id as TSQualifiedName).left) {
          const name = id.type === 'TSQualifiedName' ? id.right : id
          if (name.type === 'Identifier') {
            declared.push([name.name, block(node)])
          }
          if (id.type !== 'TSQualifiedName') {
            break
          }
        }
        break
    }
    if (DECLARED_TYPES.has(node.type) && 'id' in node && node.id?.type === 'Identifier') {
      declared.push([node.id.name, block(node)])
    }
  })
  const within = (node: Node, scope: Node) => node === scope || ancestor(node, current => current === scope) !== undefined
  return [...new Set(referenced.filter(([name, node]) => !declared.some(([local, scope]) => local === name && within(node, scope))).map(([name]) => name))]
}

/** The import declarations of `code`, the contents of `source`, or of the scripts of a single-file component. */
function importDeclarations(source: string, code: string): ImportDeclaration[] {
  const scripts = source.endsWith('.vue')
    ? [...code.matchAll(SFC_SCRIPT_RE)].map(({ 1: tag, 2: content }) => ({ filename: `${source}.${tag!.match(SFC_LANG_RE)?.[1] ?? 'ts'}`, content: content! }))
    : [{ filename: source, content: code }]
  return scripts.flatMap(({ filename, content }) => parseModule(content, filename).program.body.filter(statement => statement.type === 'ImportDeclaration'))
}

/**
 * `declaration` with the imports of `source` (`code`, the file's contents) that it refers to by
 * name but no longer imports. TypeScript leaves out a named type import from a module declared
 * as `declare module '#build/*'` while keeping the references to it, and the app that installs
 * the module resolves the alias.
 */
export async function restoreImports(declaration: string, source: string, code: string): Promise<string> {
  const missing = unboundNames(declaration)
  if (!missing.length) {
    return declaration
  }
  const pending = new Set(missing)
  const imports: string[] = []
  for (const statement of importDeclarations(source, code)) {
    if (!statement.specifiers.length) {
      continue
    }
    const specifier = `'${statement.source.value.replaceAll('\'', '\\\'')}'`
    const bound = (type: string) => statement.specifiers.flatMap(element => element.type === type && pending.delete(element.local.name) ? [element] : [])
    for (const element of bound('ImportDefaultSpecifier')) {
      imports.push(`import type ${element.local.name} from ${specifier};`)
    }
    for (const element of bound('ImportNamespaceSpecifier')) {
      imports.push(`import type * as ${element.local.name} from ${specifier};`)
    }
    const named = bound('ImportSpecifier') as ImportSpecifier[]
    if (named.length) {
      imports.push(`import type { ${named.map(element => element.imported.start === element.local.start ? element.local.name : `${element.imported.type === 'Literal' ? JSON.stringify(element.imported.value) : element.imported.name} as ${element.local.name}`).join(', ')} } from ${specifier};`)
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
