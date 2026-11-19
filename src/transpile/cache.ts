import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'pathe'

import { isPlainObject, NODE_MODULES_RE } from '../utils.ts'

/** What a stored result was computed from, as content hashes. */
interface Manifest {
  /** Files outside `node_modules`. */
  files: Record<string, string>
  /**
   * The directories of those files and their parents, apart from the module root, with a hash of
   * the names they contain and of their `package.json`, so a new file or a changed `package.json`
   * that would change module resolution is noticed.
   */
  dirs: Record<string, string>
  /** The `package.json` of each package in `node_modules` that a file was read from. */
  packages: Record<string, string>
  /** The size and modification time of each file read from a package in `node_modules`. */
  stats: Record<string, string>
}

const MANIFEST_KINDS = ['files', 'dirs', 'packages', 'stats'] as const

interface Entry<T> {
  manifest: Manifest
  value: T
}

export interface ContentCache<T> {
  /** The stored value, when every input it was computed from is unchanged. */
  read: () => Promise<T | undefined>
  /**
   * Stores `value`, computed from `inputs`: every file the computation read, with the text it
   * read where known, so that a file changed since is not recorded with its new contents.
   */
  write: (value: T, inputs: Map<string, string | undefined>) => Promise<void>
}

const PACKAGE_DIR_RE = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/

const hash = (contents: string | Buffer) => createHash('sha256').update(contents).digest('hex').slice(0, 16)

const hashText = (text: string) => hash(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)

async function hashFile(file: string) {
  return readFile(file, 'utf8').then(hashText, () => undefined)
}

async function hashDir(dir: string) {
  const names = await readdir(dir).catch(() => undefined)
  if (!names) {
    return
  }
  const pkg = names.includes('package.json') ? await readFile(join(dir, 'package.json'), 'utf8').catch(() => '') : ''
  return hash(`${names.sort().join('\0')}\0${pkg}`)
}

async function hashStat(file: string) {
  return stat(file).then(({ size, mtimeMs }) => `${size}:${mtimeMs}`, () => undefined)
}

function packageJsonOf(file: string) {
  const dir = file.match(PACKAGE_DIR_RE)?.[1]
  return dir && join(dir, 'package.json')
}

async function createManifest(cwd: string, inputs: Map<string, string | undefined>): Promise<Manifest | undefined> {
  const files = new Map<string, string | undefined>()
  const packaged = new Set<string>()
  const packages = new Set<string>()
  for (const [input, text] of inputs) {
    const file = normalize(input)
    if (NODE_MODULES_RE.test(file)) {
      const pkg = packageJsonOf(file)
      if (pkg && existsSync(pkg)) {
        packages.add(pkg)
        packaged.add(file)
        continue
      }
    }
    files.set(file, text)
  }
  const root = normalize(cwd)
  const dirs = new Set([...files.keys()].filter(file => !NODE_MODULES_RE.test(file)).flatMap(file => [dirname(file), dirname(dirname(file))]).filter(dir => dir !== root))
  const manifest: Manifest = { files: {}, dirs: {}, packages: {}, stats: {} }
  const entries = await Promise.all([
    ...[...files].map(async ([file, text]) => ['files', file, text === undefined ? await hashFile(file) : hashText(text)] as const),
    ...[...dirs].map(async dir => ['dirs', dir, await hashDir(dir)] as const),
    ...[...packages].map(async pkg => ['packages', pkg, await hashFile(pkg)] as const),
    ...[...packaged].map(async file => ['stats', file, await hashStat(file)] as const),
  ])
  for (const [kind, path, digest] of entries) {
    if (digest === undefined) {
      return
    }
    manifest[kind][path] = digest
  }
  return manifest
}

const HASHES = { files: hashFile, dirs: hashDir, packages: hashFile, stats: hashStat }

async function isCurrent(manifest: unknown) {
  if (!isPlainObject(manifest) || !MANIFEST_KINDS.every(kind => isPlainObject(manifest[kind]))) {
    return false
  }
  const checks = await Promise.all(MANIFEST_KINDS.flatMap(kind => Object.entries(manifest[kind] as Record<string, string>).map(async ([path, digest]) => await HASHES[kind](path) === digest)))
  return checks.every(Boolean)
}

/**
 * A result stored in `node_modules/.cache/transpile-dir` of `cwd` under `key`, which holds every
 * input that is not a file (options, versions), and reused while the files it was computed from
 * are unchanged. Files in `node_modules` are compared by the `package.json` of their package and
 * by their size and modification time. An entry that can't be read counts as missing.
 */
export function contentCache<T>(cwd: string, name: string, key: unknown): ContentCache<T> {
  const file = join(cwd, 'node_modules/.cache/transpile-dir/results', `${name}-${hash(JSON.stringify(key))}.json`)
  return {
    async read() {
      if (!existsSync(file)) {
        return
      }
      const entry = await readFile(file, 'utf8').then(text => JSON.parse(text) as Partial<Entry<T>> | null).catch(() => undefined)
      return isPlainObject(entry) && 'value' in entry && await isCurrent(entry.manifest) ? entry.value : undefined
    },
    async write(value, inputs) {
      const manifest = await createManifest(cwd, inputs)
      if (!manifest) {
        return
      }
      await mkdir(dirname(file), { recursive: true })
      const temp = `${file}.${randomUUID()}`
      await writeFile(temp, JSON.stringify({ manifest, value } satisfies Entry<T>))
      await rename(temp, file).catch(() => rm(temp, { force: true }))
    },
  }
}
