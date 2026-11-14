import { existsSync, promises as fsp } from 'node:fs'
import { relative, resolve } from 'pathe'
import { findExports, findTypeExports } from 'mlly'
import type { ESMExport } from 'mlly'

const TYPE_ONLY_DECLARATIONS = new Set(['interface', 'type'])
const VALUE_DECLARATION_RE = /\bexport\s+declare\s+(?:async\s+function|function|const\s+enum|const|let|var|class|enum)\s+([$\w]+)/g

/**
 * Writes `module.d.mts`, which re-exports `entry`, and the `types.d.mts` that adds its type
 * augmentations, into `dir`.
 */
export async function writeSourceTypes(dir: string, entry: string): Promise<void> {
  const source = await fsp.readFile(entry, 'utf8')
  const hasDefaultExport = findExports(source).some(e => e.type === 'default' || e.names?.includes('default'))
  // TypeScript resolves the `.js` specifier to the `.ts` source without `allowImportingTsExtensions`.
  const specifier = relative(dir, entry).replace(/\.([cm]?)tsx?$/, '.$1js')
  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(resolve(dir, 'module.d.mts'), [
    `export * from '${specifier}'`,
    ...hasDefaultExport ? [`export { default } from '${specifier}'`] : [],
  ].join('\n') + '\n', 'utf8')
  await writeTypes(dir, source)
}

/**
 * Writes `types.d.mts` into `distDir`, from the declarations in `module.d.mts` or, for
 * `module.d.mts` that re-exports the module's sources, from `entrySource`.
 */
export async function writeTypes(distDir: string, entrySource?: string): Promise<void> {
  const dtsFile = resolve(distDir, 'types.d.mts')
  if (existsSync(dtsFile)) {
    return
  }

  const moduleReExports: ESMExport[] = []
  const typeOnlyExports = new Set<string>()
  if (entrySource === undefined) {
    // Read generated module types
    const moduleTypesFile = resolve(distDir, 'module.d.mts')
    const moduleTypes = await fsp.readFile(moduleTypesFile, 'utf8').catch(() => '')
    const exports = findExports(withoutTypeModifiers(moduleTypes))
    const typeExports = findTypeExports(moduleTypes)
    moduleReExports.push(...exports, ...typeExports)

    const valueExports = new Set<string>()
    for (const e of findExports(moduleTypes)) {
      if (e.type === 'named' || e.type === 'default') {
        for (const name of e.names) {
          valueExports.add(name)
        }
      }
    }
    for (const e of typeExports) {
      const isTypeOnly = e.type === 'named' || (e.type === 'declaration' && e.declarationType !== undefined && TYPE_ONLY_DECLARATIONS.has(e.declarationType))
      const target = isTypeOnly ? typeOnlyExports : valueExports
      for (const name of e.names) {
        target.add(name)
      }
    }

    // `findTypeExports` drops a value declaration that shares its name with a type
    // export, so read those names from the generated declarations too.
    for (const match of moduleTypes.matchAll(VALUE_DECLARATION_RE)) {
      valueExports.add(match[1]!)
    }

    // `findExports` only reports `export { type Foo }` after the `type` keyword is removed,
    // so names it finds only in the normalised types are type-only.
    for (const e of exports) {
      if (e.type !== 'named' && e.type !== 'default') {
        continue
      }
      for (const name of e.names) {
        if (!valueExports.has(name)) {
          typeOnlyExports.add(name)
        }
      }
    }

    for (const name of valueExports) {
      typeOnlyExports.delete(name)
    }
  }

  const appShims: string[] = []
  const schemaShims: string[] = []
  const moduleImports: string[] = []
  const schemaImports: string[] = []
  const moduleExports: string[] = []

  // A star re-export in the source may export any name, so it counts as exporting all of them.
  const sourceExports = entrySource === undefined ? undefined : [...findExports(withoutTypeModifiers(entrySource)), ...findTypeExports(entrySource)]
  const hasTypeExport = (name: string) => sourceExports
    ? sourceExports.some(exp => exp.type === 'star' || exp.names?.includes(name))
    : moduleReExports.some(exp => exp.names?.includes(name))

  if (!hasTypeExport('ModuleOptions')) {
    schemaImports.push('NuxtModule')
    moduleImports.push('default as Module')
    moduleExports.push(`export type ModuleOptions = typeof Module extends NuxtModule<infer O> ? Partial<O> : Record<string, any>`)
  }

  if (hasTypeExport('ModuleHooks')) {
    moduleImports.push('ModuleHooks')
    schemaShims.push('  interface NuxtHooks extends ModuleHooks {}')
  }

  if (hasTypeExport('ModuleRuntimeHooks')) {
    moduleImports.push('ModuleRuntimeHooks')
    appShims.push(`  interface RuntimeNuxtHooks extends ModuleRuntimeHooks {}`)
  }

  if (hasTypeExport('ModuleRuntimeConfig')) {
    moduleImports.push('ModuleRuntimeConfig')
    schemaShims.push('  interface RuntimeConfig extends ModuleRuntimeConfig {}')
  }
  if (hasTypeExport('ModulePublicRuntimeConfig')) {
    moduleImports.push('ModulePublicRuntimeConfig')
    schemaShims.push('  interface PublicRuntimeConfig extends ModulePublicRuntimeConfig {}')
  }

  const dtsContents = `
  ${schemaImports.length ? `import type { ${schemaImports.join(', ')} } from '@nuxt/schema'` : ''}

${moduleImports.length ? `import type { ${moduleImports.join(', ')} } from './module.mjs'` : ''}

${appShims.length ? `declare module '#app' {\n${appShims.join('\n')}\n}\n` : ''}
${schemaShims.length ? `declare module '@nuxt/schema' {\n${schemaShims.join('\n')}\n}\n` : ''}
${moduleExports.length ? `\n${moduleExports.join('\n')}` : ''}
${sourceExports ? 'export * from "./module.mjs"\nexport { default } from "./module.mjs"' : ''}
${[...groupNamedReExports(moduleReExports)].map(([specifier, names]) => `\nexport { ${names.map(n => (n === 'default' || !typeOnlyExports.has(n) ? '' : 'type ') + n).join(', ')} } from '${specifier}'`).join('\n')}
${moduleReExports.filter(e => e.type === 'star').map(e => `\nexport * from '${e.specifier || './module.mjs'}'`).join('\n')}
`.trim().replace(/[\n\r]{3,}/g, '\n\n') + '\n'

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
}

/** `code` with `export { type Foo }` written as `export { Foo }`, which `findExports` reports. */
function withoutTypeModifiers(code: string) {
  return code.replace(/export\s*\{.*?\}/gs, match => match.replace(/\b(type|interface)\b/g, ''))
}

function groupNamedReExports(exports: ESMExport[]) {
  const groups = new Map<string, Set<string>>()
  for (const e of exports) {
    if (e.type !== 'named' && e.type !== 'default' && e.type !== 'declaration') {
      continue
    }
    const specifier = e.specifier || './module.mjs'
    const names = groups.get(specifier) ?? new Set()
    for (const name of e.names) {
      names.add(name)
    }
    groups.set(specifier, names)
  }
  return new Map([...groups].map(([specifier, names]) => [
    specifier,
    [...names].sort((a, b) => a === 'default' ? 1 : b === 'default' ? -1 : a.localeCompare(b)),
  ]))
}
