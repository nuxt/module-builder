import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, relative, resolve } from 'pathe'
import { resolvePathSync } from 'mlly'
import { createPathsMatcher, getTsconfig } from 'get-tsconfig'
import type ts from 'typescript'

import type { Transform } from '../transpile/transpile-dir.ts'
import { isInside, NODE_MODULES_RE, probe, relativeSpecifier, SCRIPT_RE, TYPESCRIPT_RE } from '../utils.ts'
import { guide } from './guide.ts'

const VIRTUAL_ALIAS_RE = /^#(?:app|imports|build)(?:\/|$)/
const PATH_ALIAS_RE = /^(?:~|@\/)/
const JSON_RE = /\.json$/
const UNLOADABLE_RE = /\.(?:vue|[jt]sx)$/

export interface ImportModuleOptions {
  /** Module root, inside which `version` applies. */
  cwd: string
  /** Source code to serve in place of these bare specifiers. */
  stubs?: Record<string, string>
  /**
   * Distinguishes this import from earlier ones of the same file, which Node would serve
   * from its cache: the file and every file it imports from inside `cwd`, outside
   * `node_modules`, are loaded afresh for each version.
   */
  version?: number
}

/**
 * Import a file as Node does, with `stubs` for bare specifiers. Module code has to load as
 * Node loads it (see {@link findModuleCodeIssues}).
 */
export async function importModule(path: string, { cwd, stubs = {}, version }: ImportModuleOptions): Promise<Record<string, unknown>> {
  const versioned = (href: string) => {
    const url = new URL(href)
    url.searchParams.set('v', String(version))
    return url.href
  }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier]!)}`, shortCircuit: true }
      }
      const resolved = nextResolve(specifier, context)
      if (!version || !resolved.url.startsWith('file:') || !isInside(cwd, fileURLToPath(resolved.url)) || NODE_MODULES_RE.test(resolved.url)) {
        return resolved
      }
      return { ...resolved, url: versioned(resolved.url) }
    },
  })
  try {
    const url = pathToFileURL(path).href
    return await import(version ? versioned(url) : url)
  }
  finally {
    hooks.deregister()
  }
}

interface Oxc {
  transform: Transform
  transformSync: (...args: Parameters<Transform>) => Awaited<ReturnType<Transform>>
}

let oxc: Oxc | null | undefined

/** The oxc bindings of the `rolldown` that `tsdown` depends on, or `null` when `tsdown` is not installed. */
export function loadOxc(): Oxc | null {
  if (oxc === undefined) {
    try {
      oxc = createRequire(import.meta.resolve('tsdown'))('rolldown/utils') as Oxc
    }
    catch {
      oxc = null
    }
  }
  return oxc
}

export interface ModuleCodeIssue {
  /** Path relative to the module root. */
  file: string
  line: number
  column: number
  /** For a file in a runtime directory, the module code that imports it, as `file:line`. */
  importedBy?: string
  /** What Node cannot load, and what to write instead. */
  message: string
}

const NON_ERASABLE: Array<[message: string, matches: (ts: typeof import('typescript'), node: ts.Node) => boolean]> = [
  ['`enum` (use an `as const` object and a union type of its values)', (ts, node) => ts.isEnumDeclaration(node)],
  ['`namespace` (use plain exports or an object)', (ts, node) => ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && !(node.flags & (ts.NodeFlags.NestedNamespace | ts.NodeFlags.GlobalAugmentation)) && hasRuntimeCode(ts, node)],
  ['angle-bracket type assertion (write `value as Type`)', (ts, node) => ts.isTypeAssertionExpression(node)],
  ['parameter property (declare the field and assign it in the constructor)', (ts, node) => ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent)],
  ['`import =` (use `import`, or `createRequire` for CommonJS)', (ts, node) => ts.isImportEqualsDeclaration(node) && !node.isTypeOnly],
  ['`export =` (use `export default`)', (ts, node) => ts.isExportAssignment(node) && !!node.isExportEquals],
  ['decorator (call the decorator as a function)', (ts, node) => ts.isDecorator(node)],
]

/**
 * Everything in `entries` and the sources they import by value, which Node loads with
 * them, that Node cannot load as written: TypeScript syntax that stripping types does not
 * remove, relative specifiers without the file's extension, tsconfig `paths` aliases and
 * the aliases only a Nuxt app provides. Type-only imports are erased before Node sees
 * them. Files in `runtimeDirs` that are not imported this way are left to the build.
 *
 * `otherEntries`, bundled entries that source exports point at as they are, only need the
 * extensions of their relative imports outside `runtimeDirs`.
 */
export function findModuleCodeIssues(cwd: string, entries: string[], runtimeDirs: string[], otherEntries: string[] = []): ModuleCodeIssue[] {
  const found: ModuleCodeIssue[] = []
  const checked = new Set<string>()
  walkSources(cwd, entries, (file, analysis, importer) => {
    checked.add(file)
    const importedBy = importer && runtimeDirs.some(dir => isInside(dir, file)) ? `${relative(cwd, importer.file)}:${importer.line}` : undefined
    const issue = (location: { line: number, column: number }, message: string) => found.push({ file: relative(cwd, file), ...location, ...importedBy && { importedBy }, message })
    for (const { message, ...location } of analysis.nonErasable) {
      issue(location, message)
    }
    for (const { specifier, typeOnly, json, resolution, ...location } of analysis.imports) {
      if (typeOnly) {
        continue
      }
      if (VIRTUAL_ALIAS_RE.test(specifier)) {
        issue(location, `\`${specifier}\` only exists in a Nuxt app (move the code that uses it into a runtime file the module adds, or import types only)`)
      }
      if (JSON_RE.test(resolution?.file ?? specifier) && !json) {
        issue(location, `\`${specifier}\` is JSON (use \`import pkg from '${specifier}' with { type: 'json' }\` and read \`pkg.version\`; destructuring \`pkg\` bundles the whole file)`)
      }
      if (!resolution) {
        continue
      }
      if (UNLOADABLE_RE.test(resolution.file)) {
        issue(location, `\`${specifier}\` is ${resolution.file.endsWith('.vue') ? 'a single-file component' : 'JSX'}, which Node cannot load (move the value the module needs into a \`.ts\` file, or use \`import type\`)`)
        continue
      }
      const suggestion = relativeSpecifier(file, resolution.file)
      if (resolution.via === 'relative' && resolution.file !== resolve(dirname(file), specifier)) {
        issue(location, `\`${specifier}\` (use \`${suggestion}\`)`)
      }
      else if (resolution.via === 'paths') {
        issue(location, `\`${specifier}\` is a tsconfig \`paths\` alias (use \`${suggestion}\`, or an entry in the \`imports\` of \`package.json\`)`)
      }
    }
  })
  walkSources(cwd, otherEntries, (file, analysis) => {
    if (checked.has(file) || runtimeDirs.some(dir => isInside(dir, file))) {
      return
    }
    for (const { specifier, typeOnly, json: _, resolution, ...location } of analysis.imports) {
      if (!typeOnly && resolution?.via === 'relative' && resolution.file !== resolve(dirname(file), specifier)) {
        found.push({ file: relative(cwd, file), ...location, message: `\`${specifier}\` (use \`${relativeSpecifier(file, resolution.file)}\`)` })
      }
    }
  })
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
}

/** Fails for {@link findModuleCodeIssues} findings. */
export function assertLoadableModuleCode(cwd: string, entries: string[], runtimeDirs: string[], otherEntries: string[] = []): void {
  const found = findModuleCodeIssues(cwd, entries, runtimeDirs, otherEntries)
  if (found.length) {
    throw new Error(formatModuleCodeIssues(found))
  }
}

/** The error message for {@link findModuleCodeIssues} findings, one line each. */
export function formatModuleCodeIssues(found: ModuleCodeIssue[]): string {
  const lines = new Set(found.map(({ file, line, column, importedBy, message }) => `  - ${file}:${line}:${column}${importedBy ? ` (imported by ${importedBy})` : ''}: ${message}`))
  return [
    'Module code has to load with Node, which strips types and resolves imports as written:',
    ...lines,
    `Change each one as suggested. ${guide('module-code-loads-with-node')}`,
  ].join('\n')
}

interface Resolution {
  file: string
  /** How the specifier reaches `file`. */
  via: 'relative' | 'imports' | 'paths'
}

interface SourceAnalysis {
  nonErasable: Array<{ line: number, column: number, message: string }>
  imports: Array<{ specifier: string, typeOnly: boolean, json: boolean, line: number, column: number, resolution?: Resolution }>
}

interface Importer {
  file: string
  line: number
}

function walkSources(cwd: string, entries: string[], visit: (file: string, analysis: SourceAnalysis, importer?: Importer) => void) {
  const matchPath = pathsMatcher(cwd)
  const seen = new Set<string>()
  const queue: Array<{ file: string, importer?: Importer }> = entries.map(entry => ({ file: resolve(cwd, entry) }))
  while (queue.length) {
    const { file, importer } = queue.shift()!
    if (seen.has(file) || !SCRIPT_RE.test(file) || !existsSync(file)) {
      continue
    }
    seen.add(file)
    const analysis = analyseSource(file, readFileSync(file, 'utf8'))
    for (const entry of analysis.imports) {
      entry.resolution = resolveSource(entry.specifier, dirname(file), cwd, matchPath)
      if (entry.resolution && !entry.typeOnly && !UNLOADABLE_RE.test(entry.resolution.file)) {
        queue.push({ file: entry.resolution.file, importer: { file, line: entry.line } })
      }
    }
    visit(file, analysis, importer)
  }
}

function resolvesAsPackage(specifier: string, parentDir: string) {
  try {
    return resolvePathSync(specifier, { url: pathToFileURL(resolve(parentDir, 'index.js')), conditions: ['import', 'node', 'default'] })
  }
  catch {
    try {
      return createRequire(resolve(parentDir, 'index.js')).resolve(specifier)
    }
    catch {
      return undefined
    }
  }
}

/**
 * The module source `specifier` reaches: a relative file, an entry in the `imports` of the
 * module's `package.json`, or a tsconfig `paths` alias. Packages and the aliases only a
 * Nuxt app provides are not followed.
 */
function resolveSource(specifier: string, parentDir: string, cwd: string, matchPath: ReturnType<typeof pathsMatcher>): Resolution | undefined {
  if (VIRTUAL_ALIAS_RE.test(specifier)) {
    return
  }
  if (specifier.startsWith('.')) {
    const file = probe(resolve(parentDir, specifier))
    return file ? { file, via: 'relative' } : undefined
  }
  const resolved = PATH_ALIAS_RE.test(specifier) ? undefined : resolvesAsPackage(specifier, parentDir)
  if (resolved) {
    return specifier.startsWith('#') && isInside(cwd, resolved) && !NODE_MODULES_RE.test(resolved) ? { file: resolved, via: 'imports' } : undefined
  }
  for (const candidate of matchPath?.(specifier) || []) {
    const file = probe(candidate)
    if (file) {
      return { file, via: 'paths' }
    }
  }
}

let typescript: typeof ts | undefined

function scriptKind(ts: typeof import('typescript'), filename: string) {
  if (TYPESCRIPT_RE.test(filename)) {
    return filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  }
  return filename.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS
}

function hasRuntimeCode(ts: typeof import('typescript'), node: ts.ModuleDeclaration): boolean {
  const { body } = node
  if (!body) {
    return false
  }
  if (ts.isModuleDeclaration(body)) {
    return hasRuntimeCode(ts, body)
  }
  return ts.isModuleBlock(body) && body.statements.some(statement => !(
    ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement)
    || (ts.isModuleDeclaration(statement) && !hasRuntimeCode(ts, statement))
  ))
}

function analyseSource(filename: string, source: string): SourceAnalysis {
  const ts = typescript ??= createRequire(import.meta.url)('typescript') as typeof import('typescript')
  const { SyntaxKind } = ts
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind(ts, filename))
  const found: SourceAnalysis = { nonErasable: [], imports: [] }
  const position = (node: ts.Node) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return { line: line + 1, column: character + 1 }
  }
  const isJson = (attributes: ts.ImportAttributes | undefined) => !!attributes?.elements.some(element => element.name.text === 'type' && ts.isStringLiteral(element.value) && element.value.text === 'json')
  // `true` when the value is not known statically.
  const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | true | undefined => {
    for (const property of [...object.properties].reverse()) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        if (property.name.text === name) {
          return property.initializer
        }
      }
      else if (!ts.isShorthandPropertyAssignment(property) || property.name.text === name) {
        return true
      }
    }
  }
  const isJsonOptions = (options: ts.Expression | undefined) => {
    if (!options || !ts.isObjectLiteralExpression(options)) {
      return !!options
    }
    const attributes = property(options, 'with')
    if (!attributes || attributes === true || !ts.isObjectLiteralExpression(attributes)) {
      return !!attributes
    }
    const type = property(attributes, 'type')
    return !!type && (type === true || !ts.isStringLiteralLike(type) || type.text === 'json')
  }
  const specifierOf = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      return { specifier: node.moduleSpecifier, typeOnly: node.importClause?.isTypeOnly ?? false, json: isJson(node.attributes) }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      return { specifier: node.moduleSpecifier, typeOnly: node.isTypeOnly, json: isJson(node.attributes) }
    }
    if (ts.isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      return { specifier: node.arguments[0], typeOnly: false, json: isJsonOptions(node.arguments[1]) }
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword)) {
      return
    }
    const nonErasable = NON_ERASABLE.find(([, matches]) => matches(ts, node))
    if (nonErasable) {
      found.nonErasable.push({ ...position(node), message: nonErasable[0] })
    }
    const imported = specifierOf(node)
    if (imported) {
      found.imports.push({ specifier: imported.specifier.text, typeOnly: imported.typeOnly, json: imported.json, ...position(imported.specifier) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function pathsMatcher(cwd: string) {
  // `prepare` checks module code before `nuxt prepare` has generated the `.nuxt/tsconfig.json`
  // that module tsconfigs extend, so a tsconfig that cannot be resolved yet means no aliases.
  try {
    const tsconfig = getTsconfig(cwd)
    return tsconfig ? createPathsMatcher(tsconfig) : undefined
  }
  catch {
    return undefined
  }
}
