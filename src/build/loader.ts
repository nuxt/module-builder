import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve } from 'pathe'
import { createPathsMatcher, getTsconfig } from 'get-tsconfig'
import type { Diagnostic } from 'nostics'
import type ts from 'typescript'

import type { Transform } from '../transpile/transpile-dir.ts'
import { packageName } from '../transpile/tsconfig.ts'
import { findPackageDir, findUp, isFile, isInside, isPlainObject, NODE_MODULES_RE, probe, relativeSpecifier, resolveFrom, SCRIPT_RE, TYPESCRIPT_RE } from '../utils.ts'
import type { PackageJson } from '../utils.ts'
import { errors } from '../diagnostics.ts'
import { importsKeyFor } from './package.ts'

const VIRTUAL_ALIAS_RE = /^#(?:app|imports|build)(?:\/|$)/
const PATH_ALIAS_RE = /^(?:~|@\/)/
const JSON_RE = /\.json$/
const UNLOADABLE_RE = /\.(?:vue|[jt]sx)$/
const IMPORT_CONDITIONS = new Set(['import', 'module-sync', 'node', 'node-addons', 'default'])

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
  /** Whether the issue is an import that the check cannot follow, so the files it imports are not checked. */
  unfollowed?: true
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
      if (typeof resolution === 'string' && resolution !== EXTERNAL) {
        found.push({ file: relative(cwd, file), ...location, ...importedBy && { importedBy }, message: `\`${specifier}\` ${resolution}`, unfollowed: true })
        continue
      }
      if (VIRTUAL_ALIAS_RE.test(specifier)) {
        issue(location, `\`${specifier}\` only exists in a Nuxt app (move the code that uses it into a runtime file the module adds, or import types only)`)
      }
      if (JSON_RE.test(typeof resolution === 'object' ? resolution.file : specifier) && !json) {
        issue(location, `\`${specifier}\` is JSON (use \`import pkg from '${specifier}' with { type: 'json' }\` and read \`pkg.version\`; destructuring \`pkg\` bundles the whole file)`)
      }
      if (typeof resolution !== 'object') {
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
      if (!typeOnly && typeof resolution === 'object' && resolution.via === 'relative' && resolution.file !== resolve(dirname(file), specifier)) {
        found.push({ file: relative(cwd, file), ...location, message: `\`${specifier}\` (use \`${relativeSpecifier(file, resolution.file)}\`)` })
      }
    }
  })
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column)
}

/** Whether Node cannot load the module code with these findings, apart from the imports the check cannot follow. */
export function hasLoadIssues(found: ModuleCodeIssue[]): boolean {
  return found.some(issue => !issue.unfollowed)
}

/** Fails for {@link findModuleCodeIssues} findings. */
export function assertLoadableModuleCode(cwd: string, entries: string[], runtimeDirs: string[], otherEntries: string[] = []): void {
  const found = findModuleCodeIssues(cwd, entries, runtimeDirs, otherEntries)
  if (hasLoadIssues(found)) {
    throw moduleCodeError(cwd, found)
  }
}

/** The error for {@link findModuleCodeIssues} findings in the module in `cwd`, which lists them one per line. */
export function moduleCodeError(cwd: string, found: ModuleCodeIssue[]): Diagnostic {
  const sources = found.flatMap(({ file, line, column, importedBy }) => [`${resolve(cwd, file)}:${line}:${column}`, ...importedBy ? [resolve(cwd, importedBy)] : []])
  return errors.NUXT_MB_B0001({ issues: found, sources: [...new Set(sources)] })
}

interface Resolution {
  file: string
  /** How the specifier reaches `file`. */
  via: 'relative' | 'imports' | 'paths'
}

/** A package or an alias only a Nuxt app provides, which the check does not follow. */
const EXTERNAL = 'external'

/** A module source, {@link EXTERNAL}, or why the check cannot follow the import. */
type SourceResolution = Resolution | typeof EXTERNAL | string

interface SourceAnalysis {
  nonErasable: Array<{ line: number, column: number, message: string }>
  imports: Array<{ specifier: string, typeOnly: boolean, json: boolean, line: number, column: number, resolution?: SourceResolution }>
}

interface Importer {
  file: string
  line: number
}

function walkSources(cwd: string, entries: string[], visit: (file: string, analysis: SourceAnalysis, importer?: Importer) => void) {
  const paths = pathsMatcher(cwd)
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
      entry.resolution = resolveSource(entry.specifier, dirname(file), cwd, paths)
      if (typeof entry.resolution === 'object' && !entry.typeOnly && !UNLOADABLE_RE.test(entry.resolution.file)) {
        queue.push({ file: entry.resolution.file, importer: { file, line: entry.line } })
      }
    }
    visit(file, analysis, importer)
  }
}

/**
 * The module source `specifier` reaches: a relative file, an entry in the `imports` of the
 * module's `package.json`, or a tsconfig `paths` alias. Packages and the aliases only a
 * Nuxt app provides are {@link EXTERNAL}. A relative file or an alias that resolves to no file
 * gives the reason instead.
 */
function resolveSource(specifier: string, parentDir: string, cwd: string, paths: ReturnType<typeof pathsMatcher>): SourceResolution {
  if (VIRTUAL_ALIAS_RE.test(specifier)) {
    return EXTERNAL
  }
  if (specifier.startsWith('.')) {
    const file = probe(resolve(parentDir, specifier))
    return file ? { file, via: 'relative' } : 'resolves to no file'
  }
  if (specifier.startsWith('#')) {
    const imported = resolvePackageImport(specifier, parentDir)
    if (imported?.target?.startsWith('./') && !imported.file) {
      return 'maps to no file in the `imports` of `package.json`'
    }
    if (imported) {
      return imported.file && isInside(cwd, imported.file) && !NODE_MODULES_RE.test(imported.file) ? { file: imported.file, via: 'imports' } : EXTERNAL
    }
  }
  else if (!PATH_ALIAS_RE.test(specifier) && resolveFrom(resolve(parentDir, 'index.js'), specifier)) {
    return EXTERNAL
  }
  const name = packageName(specifier)
  const packageDir = name && findPackageDir(name, parentDir)
  if (packageDir && exportsSubpath(packageDir, `.${specifier.slice(name.length)}`)) {
    return EXTERNAL
  }
  const candidates = paths.match?.(specifier) ?? []
  for (const candidate of candidates) {
    const file = probe(candidate)
    if (file) {
      return { file, via: 'paths' }
    }
  }
  if (paths.isAlias?.(specifier)) {
    return 'is a tsconfig `paths` alias that resolves to no file'
  }
  if (name || specifier.includes(':')) {
    return EXTERNAL
  }
  return paths.readable ? 'matches no tsconfig `paths` alias' : 'is an alias, and the tsconfig that can map it in `paths` cannot be read'
}

/** Whether the package in `dir` exposes `subpath`, `.` or `./` followed by a path, to importers. */
function exportsSubpath(dir: string, subpath: string) {
  const { exports } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as PackageJson
  if (exports === undefined) {
    return subpath === '.' || !!probe(join(dir, subpath))
  }
  const keys = isPlainObject(exports) ? Object.keys(exports).filter(key => key.startsWith('.')) : []
  return keys.length ? !!importsKeyFor(keys, subpath) : subpath === '.'
}

/** Whether `specifier` matches the `imports` of the closest `package.json`, and the target and source file it maps to with the conditions of `import`. */
function resolvePackageImport(specifier: string, parentDir: string): { target?: string, file?: string } | undefined {
  const scope = findUp(parentDir, dir => existsSync(join(dir, 'package.json')) ? dir : undefined)
  const { imports } = scope ? JSON.parse(readFileSync(join(scope, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as PackageJson : {}
  const key = isPlainObject(imports) ? importsKeyFor(Object.keys(imports), specifier) : undefined
  if (!scope || !key) {
    return
  }
  const star = key.indexOf('*')
  const target = importTarget((imports as Record<string, unknown>)[key], star === -1 ? undefined : specifier.slice(star, specifier.length - key.length + star + 1))
  const file = target?.startsWith('./') ? resolve(scope, target) : undefined
  return { target, file: file && isFile(file) ? file : undefined }
}

function importTarget(target: unknown, match: string | undefined): string | undefined {
  if (typeof target === 'string') {
    return match === undefined ? target : target.replaceAll('*', match)
  }
  if (Array.isArray(target)) {
    return target.map(item => importTarget(item, match)).find(item => item !== undefined)
  }
  if (isPlainObject(target)) {
    for (const [condition, value] of Object.entries(target)) {
      const resolved = IMPORT_CONDITIONS.has(condition) ? importTarget(value, match) : undefined
      if (resolved !== undefined) {
        return resolved
      }
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

interface PathsMatcher {
  /** The files that `specifier` maps to, through `paths` or else `baseUrl`. */
  match?: (specifier: string) => string[]
  /** Whether a `paths` pattern other than the catch-all `*` matches `specifier`. */
  isAlias?: (specifier: string) => boolean
  readable: boolean
}

function pathsMatcher(cwd: string): PathsMatcher {
  // `prepare` checks module code before `nuxt prepare` has generated the `.nuxt/tsconfig.json`
  // that module tsconfigs extend, so the aliases of a tsconfig that cannot be resolved yet are unknown.
  try {
    const tsconfig = getTsconfig(cwd)
    const patterns = Object.keys(tsconfig?.config.compilerOptions?.paths ?? {}).filter(pattern => pattern !== '*')
    const isAlias = (specifier: string) => patterns.some((pattern) => {
      const star = pattern.indexOf('*')
      return star === -1 ? pattern === specifier : specifier.length >= pattern.length - 1 && specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
    })
    return { match: tsconfig ? createPathsMatcher(tsconfig) ?? undefined : undefined, isAlias, readable: true }
  }
  catch {
    return { readable: false }
  }
}
