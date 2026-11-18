import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'pathe'
import type ts from 'typescript'

import { parseModule } from '../transpile/specifiers.ts'
import { probe, writeIfChanged } from '../utils.ts'

interface ExportedName {
  name: string
  /** Whether this export only exports a type: `export type`, `export { type Foo }`, an interface or a type alias. */
  typeOnly: boolean
}

interface ModuleExport {
  names: ExportedName[]
  specifier?: string
  /** For `export *` and `export * as`, whether it is `export type *`. */
  star?: { typeOnly: boolean }
}

const IDENTIFIER_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

const exportName = (name: string) => IDENTIFIER_RE.test(name) ? name : JSON.stringify(name)

const DECLARATION_SUFFIXES: Record<string, string[]> = {
  '': ['.d.ts', '.d.mts', '.d.cts', '/index.d.ts', '/index.d.mts'],
  '.js': ['.d.ts'],
  '.mjs': ['.d.mts'],
  '.cjs': ['.d.cts'],
}

/**
 * Writes `module.d.mts`, which re-exports `entry`, and the `types.d.mts` that adds its type
 * augmentations, into `dir`. With `reExported`, `module.d.mts` re-exports that path instead,
 * such as where the declarations of `entry` are written.
 */
export async function writeSourceTypes(dir: string, entry: string, reExported: string = entry): Promise<void> {
  const source = await fsp.readFile(entry, 'utf8')
  const hasDefaultExport = parseExports(source, entry).some(e => e.names.some(({ name }) => name === 'default'))
  // TypeScript resolves the `.js` specifier to the `.ts` source, or to its declaration, without `allowImportingTsExtensions`.
  const path = relative(dir, reExported).replace(/\.([cm]?)tsx?$/, '.$1js')
  const specifier = path.startsWith('.') ? path : `./${path}`
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(resolve(dir, 'module.d.mts'), [
    `export * from '${specifier}'`,
    ...hasDefaultExport ? [`export { default } from '${specifier}'`] : [],
  ].join('\n') + '\n', 'utf8')
  await writeTypes(dir, { exports: exportedNames(entry) })
}

/**
 * Writes `types.d.mts` into `distDir`, from the declarations in `module.d.mts` or, for
 * `module.d.mts` that re-exports the module's sources, from the names the sources export.
 * Unknown names (`exports: undefined`) count as exported.
 */
export async function writeTypes(distDir: string, source?: { exports: Set<string> | undefined }): Promise<void> {
  const dtsFile = resolve(distDir, 'types.d.mts')

  let moduleReExports: ModuleExport[] = []
  let typeOnlyExports = new Set<string>()
  if (!source) {
    const moduleTypes = await fsp.readFile(resolve(distDir, 'module.d.mts'), 'utf8').catch(() => '')
    moduleReExports = parseExports(moduleTypes, 'module.d.mts')
    const names = moduleReExports.flatMap(e => e.names)
    const valueExports = new Set(names.filter(e => !e.typeOnly).map(e => e.name))
    typeOnlyExports = new Set(names.map(e => e.name).filter(name => !valueExports.has(name)))
  }

  const appShims: string[] = []
  const schemaShims: string[] = []
  const moduleImports: string[] = []
  const schemaImports: string[] = []
  const moduleExports: string[] = []

  const hasTypeExport = (name: string) => source
    ? !source.exports || source.exports.has(name)
    : moduleReExports.some(e => e.names.some(exported => exported.name === name))

  if (!hasTypeExport('ModuleOptions')) {
    schemaImports.push('NuxtModule')
    moduleImports.push('default as Module')
    moduleExports.push(`export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`)
  }

  for (const [name, shims, augmented] of [
    ['ModuleHooks', schemaShims, 'NuxtHooks'],
    ['ModuleRuntimeHooks', appShims, 'RuntimeNuxtHooks'],
    ['ModuleRuntimeConfig', schemaShims, 'RuntimeConfig'],
    ['ModulePublicRuntimeConfig', schemaShims, 'PublicRuntimeConfig'],
  ] as const) {
    if (hasTypeExport(name)) {
      moduleImports.push(name)
      shims.push(`  interface ${augmented} extends ${name} {}`)
    }
  }

  const namedReExports = namedExports(moduleReExports)
  const dtsContents = `
  ${schemaImports.length ? `import type { ${schemaImports.join(', ')} } from '@nuxt/schema'` : ''}

${moduleImports.length ? `import type { ${moduleImports.join(', ')} } from './module.mjs'` : ''}

${appShims.length ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length ? `\n${moduleExports.join('\n')}` : ''}
${source ? 'export * from "./module.mjs"\nexport { default } from "./module.mjs"' : ''}
${namedReExports.length ? `\nexport { ${namedReExports.map(n => (n === 'default' || !typeOnlyExports.has(n) ? '' : 'type ') + exportName(n)).join(', ')} } from './module.mjs'` : ''}
${moduleReExports.filter(e => e.star).map(e => `\nexport ${e.star!.typeOnly ? 'type ' : ''}*${e.names[0] ? ` as ${exportName(e.names[0].name)}` : ''} from '${e.specifier!.replace(/[\\']/g, '\\$&')}'`).join('\n')}
`.trim().replace(/[\n\r]{3,}/g, '\n\n') + '\n'

  await writeIfChanged(dtsFile, dtsContents)
}

/**
 * The names a source file exports, following star re-exports of relative files, or `undefined`
 * when a star re-export cannot be followed and may export any name.
 */
function exportedNames(file: string, seen = new Set<string>()): Set<string> | undefined {
  const names = new Set<string>()
  if (seen.has(file)) {
    return names
  }
  seen.add(file)
  for (const exp of parseExports(readFileSync(file, 'utf8'), file)) {
    if (!exp.star || exp.names.length) {
      exp.names.forEach(({ name }) => names.add(name))
      continue
    }
    const target = exp.specifier?.startsWith('.') ? probeWithDeclarations(resolve(dirname(file), exp.specifier)) : undefined
    const reExported = target && exportedNames(target, seen)
    if (!reExported) {
      return
    }
    reExported.forEach(name => name !== 'default' && names.add(name))
  }
  return names
}

/** The source file `path` resolves to, or the declaration file when there is no source. */
function probeWithDeclarations(path: string) {
  const extension = path.match(/\.[cm]?js$/)?.[0] ?? ''
  const base = path.slice(0, path.length - extension.length)
  return probe(path) ?? DECLARATION_SUFFIXES[extension]!.map(suffix => base + suffix).find(candidate => existsSync(candidate))
}

function parseExports(code: string, filename: string): ModuleExport[] {
  const { ts, sourceFile } = parseModule(code, filename)
  const exports: ModuleExport[] = []
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === kind)
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        exports.push({ specifier, names: clause.elements.map(element => ({ name: element.name.text, typeOnly: statement.isTypeOnly || element.isTypeOnly })) })
      }
      else if (specifier) {
        exports.push({ specifier, star: { typeOnly: statement.isTypeOnly }, names: clause ? [{ name: clause.name.text, typeOnly: statement.isTypeOnly }] : [] })
      }
    }
    else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) {
        exports.push({ names: [{ name: 'default', typeOnly: false }] })
      }
    }
    else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const typeOnly = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      const names = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? ['default'] : declaredNames(ts, statement)
      exports.push({ names: names.map(name => ({ name, typeOnly })) })
    }
  }
  return exports
}

function declaredNames(ts: typeof import('typescript'), statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap(declaration => bindingNames(ts, declaration.name))
  }
  const name = (statement as ts.DeclarationStatement).name
  return name && ts.isIdentifier(name) ? [name.text] : []
}

function bindingNames(ts: typeof import('typescript'), name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text]
  }
  return name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(ts, element.name) : [])
}

/** The names that `exports` declare or re-export by name, sorted with `default` last. */
function namedExports(exports: ModuleExport[]) {
  const names = new Set(exports.flatMap(e => e.star ? [] : e.names.map(({ name }) => name)))
  return [...names].sort((a, b) => a === 'default' ? 1 : b === 'default' ? -1 : a.localeCompare(b))
}
