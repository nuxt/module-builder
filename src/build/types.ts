import { existsSync, promises as fsp, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'pathe'
import type { BindingPattern, Declaration, ModuleExportName, TSTypeName } from '@oxc-project/types'

import { parseModule } from '../transpile/oxc.ts'
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

  for (const [name, augmented] of AUGMENTED) {
    const shims = augmented === 'RuntimeNuxtHooks' ? appShims : schemaShims
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

/** The interfaces of the module entry that `types.d.mts` merges into Nuxt's. */
const AUGMENTED = [
  ['ModuleHooks', 'NuxtHooks'],
  ['ModuleRuntimeHooks', 'RuntimeNuxtHooks'],
  ['ModuleRuntimeConfig', 'RuntimeConfig'],
  ['ModulePublicRuntimeConfig', 'PublicRuntimeConfig'],
] as const

/** Whether `types.d.mts` augments Nuxt's types with interfaces that `entry` may export. */
export function augmentsNuxtTypes(entry: string): boolean {
  const names = exportedNames(entry)
  return !names || AUGMENTED.some(([name]) => names.has(name))
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
  const exports: ModuleExport[] = []
  for (const statement of parseModule(code, filename).program.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      const { declaration } = statement
      const typeOnly = declaration.type === 'TSInterfaceDeclaration' || declaration.type === 'TSTypeAliasDeclaration'
      exports.push({ names: declaredNames(declaration).map(name => ({ name, typeOnly })) })
    }
    else if (statement.type === 'ExportNamedDeclaration') {
      exports.push({ specifier: statement.source?.value, names: statement.specifiers.map(element => ({ name: moduleExportName(element.exported), typeOnly: statement.exportKind === 'type' || element.exportKind === 'type' })) })
    }
    else if (statement.type === 'ExportAllDeclaration') {
      const typeOnly = statement.exportKind === 'type'
      exports.push({ specifier: statement.source.value, star: { typeOnly }, names: statement.exported ? [{ name: moduleExportName(statement.exported), typeOnly }] : [] })
    }
    else if (statement.type === 'ExportDefaultDeclaration') {
      exports.push({ names: [{ name: 'default', typeOnly: statement.declaration.type === 'TSInterfaceDeclaration' }] })
    }
  }
  return exports
}

const moduleExportName = (name: ModuleExportName) => name.type === 'Literal' ? name.value : name.name

const leftmost = (name: TSTypeName): TSTypeName => name.type === 'TSQualifiedName' ? leftmost(name.left) : name

function declaredNames(declaration: Declaration): string[] {
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap(declarator => bindingNames(declarator.id))
  }
  const id = 'id' in declaration && declaration.id ? declaration.id.type === 'TSQualifiedName' ? leftmost(declaration.id) : declaration.id : undefined
  return id?.type === 'Identifier' ? [id.name] : []
}

function bindingNames(pattern: BindingPattern): string[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name]
    case 'AssignmentPattern':
      return bindingNames(pattern.left)
    case 'ObjectPattern':
      return pattern.properties.flatMap(property => bindingNames(property.type === 'RestElement' ? property.argument : property.value))
    case 'ArrayPattern':
      return pattern.elements.flatMap(element => !element ? [] : bindingNames(element.type === 'RestElement' ? element.argument : element))
  }
}

/** The names that `exports` declare or re-export by name, sorted with `default` last. */
function namedExports(exports: ModuleExport[]) {
  const names = new Set(exports.flatMap(e => e.star ? [] : e.names.map(({ name }) => name)))
  return [...names].sort((a, b) => a === 'default' ? 1 : b === 'default' ? -1 : a.localeCompare(b))
}
