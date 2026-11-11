import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { consola } from 'consola'
import { dirname, relative, resolve } from 'pathe'
import { findExports, findStaticImports, parseStaticImport } from 'mlly'
import type { NamedExport } from 'mlly'
import { createPathsMatcher, getTsconfig } from 'get-tsconfig'
import type ts from 'typescript'

import type { Transform } from '../rolldown/transpile-dir.ts'
import { guide } from './guide.ts'

const VIRTUAL_ALIAS_RE = /^#(?:app|imports|build)(?:\/|$)/
const ALIAS_SHAPED_RE = /^(?:#|~|@\/)/
const EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']

export interface ImportModuleOptions {
  /** Module root, used to resolve tsconfig path aliases in un-bundled sources. */
  cwd?: string
  /** Source code to serve in place of these bare specifiers. */
  stubs?: Record<string, string>
}

/**
 * Import a file with the resolution affordances a Nuxt module's source expects
 * but plain Node ESM does not provide:
 *
 * - `#app`, `#imports` and `#build` are build-time-only aliases with no package
 *   resolution, so a module entry that transitively imports runtime code cannot be
 *   loaded at all without standing in something for them.
 * - extensionless relative specifiers and tsconfig `paths` aliases, which matter
 *   when importing TypeScript sources directly (`--stub`, `build.config.ts`).
 */
export async function importModule(path: string, options: ImportModuleOptions = {}) {
  const cwd = options.cwd ?? process.cwd()
  const matchPath = options.cwd ? pathsMatcher(options.cwd) : undefined
  const stubs = options.stubs || {}

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (Object.hasOwn(stubs, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier]!)}`, shortCircuit: true }
      }

      if (VIRTUAL_ALIAS_RE.test(specifier)) {
        return { url: stubURL(specifier, context.parentURL), shortCircuit: true }
      }

      const parentDir = context.parentURL?.startsWith('file:') ? dirname(fileURLToPath(context.parentURL)) : undefined

      if (specifier.startsWith('.') && parentDir) {
        const file = probe(resolve(parentDir, specifier))
        if (file) {
          return { url: pathToFileURL(file).href, shortCircuit: true }
        }
      }

      const fromPaths = () => {
        for (const candidate of matchPath?.(specifier) || []) {
          const file = probe(candidate)
          if (file) {
            return { url: pathToFileURL(file).href, shortCircuit: true as const }
          }
        }
      }

      // A wildcard `paths` entry such as `{ "*": ["./src/*"] }` matches every bare
      // specifier, so real packages have to win over the alias table. Alias-shaped
      // specifiers cannot name a package, so they stay paths-first.
      if (ALIAS_SHAPED_RE.test(specifier)) {
        return fromPaths() || nextResolve(specifier, context)
      }

      try {
        return nextResolve(specifier, context)
      }
      catch (error) {
        const resolved = fromPaths()
        if (!resolved) {
          throw error
        }
        return resolved
      }
    },
    // Single-file components are copied to `dist/runtime` verbatim and Node has no
    // loader for them, but a module entry only ever needs their identity here.
    load(url, context, nextLoad) {
      if (url.endsWith('.vue')) {
        return { format: 'module', source: 'export default {}', shortCircuit: true }
      }
      if (url.startsWith('file:') && TYPESCRIPT_RE.test(url)) {
        const result = transpile(url, cwd)
        if (result) {
          return result
        }
      }
      try {
        return nextLoad(url, context)
      }
      catch (error) {
        if ((error as { code?: string }).code === 'ERR_IMPORT_ATTRIBUTE_MISSING' && url.startsWith('file:') && url.endsWith('.json')) {
          return { format: 'module', source: jsonModule(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true }
        }
        throw error
      }
    },
  })

  try {
    return await import(pathToFileURL(path).href)
  }
  finally {
    hooks.deregister()
  }
}

const TYPESCRIPT_RE = /\.[cm]?tsx?$/

interface Oxc {
  transform: Transform
  transformSync: (filename: string, source: string, options: Record<string, unknown>) => { code: string, errors: Array<{ message: string }> }
  parseSync: (filename: string, source: string, options: Record<string, unknown>) => { program: unknown }
  Visitor: new (visitor: Record<string, (node: SyntaxNode) => void>) => { visit: (program: unknown) => void }
}

interface SyntaxNode {
  start: number
  declare?: boolean
  kind?: string
}

let oxc: Oxc | null | undefined

/** The oxc bindings of the `rolldown` that `tsdown` depends on, or `null` when `tsdown` is not installed. */
export function loadOxc() {
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

const NON_ERASABLE_NODE_TYPES = ['TSParameterProperty', 'TSTypeAssertion', 'TSImportEqualsDeclaration', 'TSExportAssignment', 'Decorator', 'TSEnumDeclaration', 'TSModuleDeclaration']

export interface NonErasableSyntax {
  /** Path relative to the module root. */
  file: string
  line: number
  column: number
  /** What the syntax is, such as `enum` or `parameter property`. */
  kind: string
}

/**
 * Every use of TypeScript syntax that Node's type stripping cannot erase in `entries`
 * and the sources they import, relative to `cwd`.
 */
export function findNonErasableSyntax(cwd: string, entries: string[]): NonErasableSyntax[] {
  const matchPath = pathsMatcher(cwd)
  const found: NonErasableSyntax[] = []
  const seen = new Set<string>()
  const queue = entries.map(entry => resolve(cwd, entry))
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file) || !TYPESCRIPT_RE.test(file) || !existsSync(file)) {
      continue
    }
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    found.push(...nonErasableSyntaxIn(file, source).map(location => ({ file: relative(cwd, file), ...location })))
    const imports = findStaticImports(source).filter(statement => !/^\s*type\s/.test(statement.imports))
    for (const { specifier } of [...imports, ...findExports(source)]) {
      const target = specifier ? resolveSource(specifier, dirname(file), matchPath) : undefined
      if (target) {
        queue.push(target)
      }
    }
  }
  return found
}

/** One line per occurrence, for a hint or warning. */
export function listNonErasableSyntax(found: NonErasableSyntax[]) {
  return found.map(({ file, line, column, kind }) => `  - ${file}:${line}:${column}: ${kind}`)
}

function resolveSource(specifier: string, parentDir: string, matchPath: ReturnType<typeof pathsMatcher>) {
  if (VIRTUAL_ALIAS_RE.test(specifier)) {
    return
  }
  if (specifier.startsWith('.')) {
    return probe(resolve(parentDir, specifier))
  }
  for (const candidate of matchPath?.(specifier) || []) {
    const file = probe(candidate)
    if (file) {
      return file
    }
  }
}

let typescript: typeof ts | undefined

function nonErasableSyntaxIn(filename: string, source: string): Array<Omit<NonErasableSyntax, 'file'>> {
  const ts = typescript ??= createRequire(import.meta.url)('typescript') as typeof import('typescript')
  const { SyntaxKind, NodeFlags } = ts
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: Array<Omit<NonErasableSyntax, 'file'>> = []
  const kindOf = (node: ts.Node) => {
    if (ts.isEnumDeclaration(node)) {
      return '`enum`'
    }
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name) && !(node.flags & (NodeFlags.NestedNamespace | NodeFlags.GlobalAugmentation))) {
      return '`namespace`'
    }
    if (ts.isTypeAssertionExpression(node)) {
      return 'angle-bracket type assertion'
    }
    if (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent)) {
      return 'parameter property'
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      return '`import =`'
    }
    if (ts.isExportAssignment(node) && node.isExportEquals) {
      return '`export =`'
    }
    if (ts.isDecorator(node)) {
      return 'decorator'
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === SyntaxKind.DeclareKeyword)) {
      return
    }
    const kind = kindOf(node)
    if (kind) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      found.push({ line: line + 1, column: character + 1, kind })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function hasNonErasableSyntax(oxc: Oxc, filename: string, source: string, lang: string) {
  let found = false
  const visitor = Object.fromEntries(NON_ERASABLE_NODE_TYPES.map(type => [type, (node: SyntaxNode) => {
    found ||= !node.declare && node.kind !== 'global'
  }]))
  new oxc.Visitor(visitor).visit(oxc.parseSync(filename, source, { lang, sourceType: 'module' }).program)
  return found
}

const reportedNonErasable = new Set<string>()

function transpile(url: string, cwd: string) {
  const oxc = loadOxc()
  if (!oxc) {
    return
  }
  const filename = resolve(fileURLToPath(url))
  const source = readFileSync(filename, 'utf8')
  const lang = filename.endsWith('x') ? 'tsx' : 'ts'
  if (!process.env.CI && !reportedNonErasable.has(filename) && hasNonErasableSyntax(oxc, filename, source, lang)) {
    const found = findNonErasableSyntax(cwd, [filename])
    for (const { file } of found) {
      reportedNonErasable.add(resolve(cwd, file))
    }
    consola.warn([
      'These files use TypeScript syntax that Node cannot strip, so they were transpiled:',
      ...listNonErasableSyntax(found),
      `Set \`erasableSyntaxOnly: true\` in your \`tsconfig.json\` and replace the syntax listed to keep the sources loadable by Node alone. ${guide('stub-builds')}`,
    ].join('\n'))
  }
  const result = oxc.transformSync(filename, source, {
    lang,
    sourceType: 'module',
    // The tsconfig of an unprepared module extends a `.nuxt/tsconfig.json` that does not exist yet.
    tsconfig: false,
    jsx: { runtime: 'automatic', importSource: 'vue' },
  })
  if (result.errors.length) {
    throw new SyntaxError(`${filename}: ${result.errors.map(e => e.message).join('\n')}`)
  }
  return { format: filename.endsWith('.cts') ? 'commonjs' : 'module', source: result.code, shortCircuit: true } as const
}

function jsonModule(source: string) {
  const data: unknown = JSON.parse(source)
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).filter(key => key !== 'default') : []
  return [
    `const data = JSON.parse(${JSON.stringify(source)})`,
    `export default data`,
    ...keys.map((key, index) => `const _${index} = data[${JSON.stringify(key)}]`),
    ...keys.length ? [`export { ${keys.map((key, index) => `_${index} as ${JSON.stringify(key)}`).join(', ')} }`] : [],
  ].join('\n')
}

function pathsMatcher(cwd: string) {
  // `--stub` runs before `nuxi prepare` has generated the `.nuxt/tsconfig.json` that
  // module tsconfigs extend, so a tsconfig that cannot be resolved yet means no aliases.
  try {
    const tsconfig = getTsconfig(cwd)
    return tsconfig ? createPathsMatcher(tsconfig) : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Find the source file a specifier refers to, trying the path as written, its
 * TypeScript counterpart, each source extension, then an `index` file.
 */
export function probe(path: string) {
  if (existsSync(path) && statSync(path).isFile()) {
    return path
  }
  const source = path.replace(/\.([cm]?)js(x?)$/, '.$1ts$2')
  if (source !== path && existsSync(source)) {
    return source
  }
  for (const extension of EXTENSIONS) {
    if (existsSync(path + extension)) {
      return path + extension
    }
  }
  for (const extension of EXTENSIONS) {
    if (existsSync(resolve(path, `index${extension}`))) {
      return resolve(path, `index${extension}`)
    }
  }
}

/**
 * The stub has to declare the exact named exports its importer asks for, because
 * ESM named imports and re-exports are resolved statically. They are read back off
 * the importing file, which by this point is plain text on disk.
 */
function stubURL(specifier: string, parentURL: string | undefined) {
  const names = new Set<string>()

  if (parentURL?.startsWith('file:')) {
    const contents = readFileSync(fileURLToPath(parentURL), 'utf8')

    for (const staticImport of findStaticImports(contents)) {
      if (staticImport.specifier !== specifier) {
        continue
      }
      for (const name of Object.keys(parseStaticImport(staticImport).namedImports || {})) {
        names.add(name)
      }
    }

    const namedExports = findExports(contents).filter((e): e is NamedExport => e.type === 'named')
    for (const namedExport of namedExports) {
      if (namedExport.specifier !== specifier) {
        continue
      }
      // `findExports` reports the exported names; a re-export needs the source names,
      // which are the left-hand side of any `as`.
      for (const binding of namedExport.exports.split(',')) {
        if (/^\s*type\s/.test(binding)) {
          continue
        }
        const name = binding.split(/\bas\b/)[0]?.trim()
        if (name) {
          names.add(name)
        }
      }
    }
  }

  const source = [
    `const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => ({}) })`,
    `export default stub`,
    ...[...names].filter(name => name !== 'default').map(name => `export { stub as ${name} }`),
  ].join('\n')

  return `data:text/javascript,${encodeURIComponent(source)}`
}
