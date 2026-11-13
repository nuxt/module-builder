import { existsSync, promises as fsp } from 'node:fs'
import { resolve } from 'pathe'
import { findExports, findTypeExports } from 'mlly'
import type { ESMExport } from 'mlly'

export async function writeTypes(distDir: string, isStub: boolean): Promise<void> {
  const dtsFile = resolve(distDir, 'types.d.mts')
  if (existsSync(dtsFile)) {
    return
  }

  const moduleReExports: ESMExport[] = []
  if (!isStub) {
    // Read generated module types
    const moduleTypesFile = resolve(distDir, 'module.d.mts')
    const moduleTypes = await fsp.readFile(moduleTypesFile, 'utf8').catch(() => '')
    const normalisedModuleTypes = moduleTypes
      // Replace `export { type Foo }` with `export { Foo }`
      .replace(/export\s*\{.*?\}/gs, match => match.replace(/\b(type|interface)\b/g, ''))
    for (const e of findExports(normalisedModuleTypes)) {
      moduleReExports.push(e)
    }
    for (const i of findTypeExports(normalisedModuleTypes)) {
      moduleReExports.push(i)
    }
  }

  const appShims: string[] = []
  const schemaShims: string[] = []
  const moduleImports: string[] = []
  const schemaImports: string[] = []
  const moduleExports: string[] = []

  const hasTypeExport = (name: string) => isStub || moduleReExports.find(exp => exp.names?.includes(name))

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
${isStub ? 'export * from "./module.mjs"\nexport { default } from "./module.mjs"' : ''}
${[...groupNamedReExports(moduleReExports)].map(([specifier, names]) => `\nexport { ${names.map(n => (n === 'default' ? '' : 'type ') + n).join(', ')} } from '${specifier}'`).join('\n')}
${moduleReExports.filter(e => e.type === 'star').map(e => `\nexport * from '${e.specifier || './module.mjs'}'`).join('\n')}
`.trim().replace(/[\n\r]{3,}/g, '\n\n') + '\n'

  await fsp.writeFile(dtsFile, dtsContents, 'utf8')
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
