import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { debuglog } from 'node:util'
import { dirname, join } from 'pathe'

import { findUp } from '../utils.ts'

/** The package that provides the JavaScript API of TypeScript 6 next to TypeScript 7. */
export const TYPESCRIPT6 = '@typescript/typescript6'

const debug = debuglog('nuxt-module-builder')

export interface TypescriptApi {
  ts: typeof import('typescript')
  /** The version of the package the API is loaded from. */
  version: string
  /** The file the API is loaded from. */
  file: string
}

/** Why neither `typescript` nor `@typescript/typescript6` provides the JavaScript API of TypeScript 6. */
export class TypescriptApiError extends Error {
  /** The package and version `typescript` resolves to, such as `typescript@7.0.2`, if it is installed. */
  readonly found?: string
  /** The package and version `@typescript/typescript6` resolves to, if it is installed. */
  readonly fallback?: string
  constructor(found: string | undefined, fallback: string | undefined) {
    super(`${found ? `\`typescript\` resolves to \`${found}\`, which has no JavaScript API` : '`typescript` is not installed'}, and ${fallback ? `\`${TYPESCRIPT6}\` resolves to \`${fallback}\`` : `\`${TYPESCRIPT6}\` is not installed`}.`)
    this.found = found
    this.fallback = fallback
  }
}

interface InstalledPackage {
  /** The directory whose `node_modules` holds the package. */
  base: string
  installedAs: string
  name?: string
  version: string
  /** The package and version, such as `typescript@6.0.3`. */
  found: string
}

/** The package installed as `name` in `node_modules` of `from` or a directory above it, leaving out `NODE_PATH` and global folders. */
function installedPackage(name: string, from: string): InstalledPackage | undefined {
  const base = findUp(from, dir => existsSync(join(dir, 'node_modules', name, 'package.json')) ? dir : undefined)
  if (!base) {
    return
  }
  const pkg = JSON.parse(readFileSync(join(base, 'node_modules', name, 'package.json'), 'utf8')) as { name?: string, version?: string }
  const version = pkg.version ?? ''
  return { base, installedAs: name, name: pkg.name, version, found: `${pkg.name ?? name}@${version}` }
}

function withApi({ base, installedAs, version }: InstalledPackage): TypescriptApi | undefined {
  const require = createRequire(join(base, 'index.js'))
  const file = require.resolve(installedAs)
  const ts = require(file) as Partial<typeof import('typescript')>
  return typeof ts.createProgram === 'function' ? { ts: ts as typeof import('typescript'), version, file } : undefined
}

/**
 * The JavaScript API of TypeScript that `from` resolves: `typescript` when it has one, as
 * TypeScript 5.9 and 6 do, or else `@typescript/typescript6` at 6.x. Throws a
 * {@link TypescriptApiError} when neither does.
 */
export function findTypescript(from: string): TypescriptApi {
  const own = installedPackage('typescript', from)
  const api = own && withApi(own)
  if (api) {
    return api
  }
  const fallback = installedPackage(TYPESCRIPT6, from)
  const fallbackApi = fallback?.name === TYPESCRIPT6 && fallback.version.split('.')[0] === '6' ? withApi(fallback) : undefined
  if (!fallbackApi) {
    throw new TypescriptApiError(own?.found, fallback?.found)
  }
  debug('the TypeScript JavaScript API is %s, as `typescript` is %s', fallback!.found, own?.found ?? 'not installed')
  return fallbackApi
}

let loaded: TypescriptApi | undefined

/** The JavaScript API of TypeScript that `@nuxt/module-builder` resolves, see {@link findTypescript}. */
export function loadTypescript(): TypescriptApi {
  return loaded ??= findTypescript(dirname(fileURLToPath(import.meta.url)))
}
