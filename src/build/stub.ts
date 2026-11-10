import { promises as fsp } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'pathe'
import { findExports } from 'mlly'
import { readPackageJSON } from 'pkg-types'

import builderPkg from '../../package.json' with { type: 'json' }
import { checkDeprecatedPackageFields } from './deprecations.ts'
import { bundledEntries } from './entries.ts'
import { writeModuleMeta } from './meta.ts'
import { writeTypes } from './types.ts'

export interface StubOptions {
  outDir: string
}

/**
 * Write plain re-export files pointing back at the module's TypeScript sources.
 * Node's type stripping loads them directly, so no bundler is involved.
 */
export async function stub(cwd: string, options: StubOptions) {
  const pkg = await readPackageJSON(cwd)
  const outDir = resolve(cwd, options.outDir)

  await rm(outDir, { recursive: true, force: true })
  await fsp.mkdir(outDir, { recursive: true })

  for (const [name, input] of Object.entries(bundledEntries(cwd, pkg))) {
    const entry = resolve(cwd, input)
    const source = await fsp.readFile(entry, 'utf8')
    const hasDefaultExport = findExports(source).some(e => e.type === 'default' || e.names?.includes('default'))

    await fsp.mkdir(dirname(resolve(outDir, name)), { recursive: true })
    const specifier = relative(dirname(resolve(outDir, name)), entry)
    const reExports = [
      `export * from '${specifier}'`,
      ...hasDefaultExport ? [`export { default } from '${specifier}'`] : [],
    ].join('\n') + '\n'

    await fsp.writeFile(resolve(outDir, `${name}.mjs`), reExports, 'utf8')
    // TypeScript resolves the `.js` specifier back to the `.ts` source without
    // requiring consumers to enable `allowImportingTsExtensions`.
    await fsp.writeFile(resolve(outDir, `${name}.d.mts`), reExports.replace(/\.([cm]?)tsx?'/g, '.$1js\''), 'utf8')
  }

  await writeModuleMeta({ cwd, outDir, pkg, builder: { [builderPkg.name]: builderPkg.version } })
  await writeTypes(outDir, true)
  await checkDeprecatedPackageFields(cwd)
}
