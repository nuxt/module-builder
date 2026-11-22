import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { debuglog } from 'node:util'
import { dirname, join, normalize } from 'pathe'

import { NODE_MODULES_RE } from '../utils.ts'
import { ENGINES } from './engine.ts'
import type { DeclarationEngine, DeclarationProject, EngineDiagnostic, ProjectOptions } from './engine.ts'

export type NativeEngineName = typeof ENGINES[keyof typeof ENGINES]

/**
 * The package each native engine is, its minimum version, and the name it is installed as when
 * the module's own copy is older. That name for TypeScript 7 is an alias in the `@typescript`
 * scope, which only Microsoft can publish to.
 */
const NATIVE_PACKAGES: Record<NativeEngineName, { name: string, package: string, minimum: [number, number] }> = {
  [ENGINES.typescript]: { name: 'typescript', package: 'typescript', minimum: [7, 1] },
  [ENGINES.typescript7]: { name: '@typescript/typescript7', package: 'typescript', minimum: [7, 1] },
  [ENGINES.tsrs]: { name: 'tsrs', package: 'tsrs', minimum: [7, 1] },
}

const debug = debuglog('nuxt-module-builder')

/** The glibc version that the Linux GNU binaries of tsrs link against. */
const TSRS_GLIBC: [number, number] = [2, 34]

export type NativeEngineProblem = 'missing' | 'version' | 'api' | 'platform'

/** Why a native engine cannot be used: its package is not installed, too old, or cannot run on this platform. */
export class NativeEngineError extends Error {
  readonly engine: NativeEngineName
  readonly reason: NativeEngineProblem
  /** The name the engine is installed as. */
  readonly installedAs: string
  /** The package and version that name resolves to, such as `typescript@7.0.2`. */
  readonly found?: string
  constructor(engine: NativeEngineName, reason: NativeEngineProblem, message: string, { found, installedAs = NATIVE_PACKAGES[engine].name, cause }: { found?: string, installedAs?: string, cause?: unknown } = {}) {
    super(message, { cause })
    this.engine = engine
    this.reason = reason
    this.installedAs = installedAs
    this.found = found
  }
}

interface NativeApi {
  API: new (options: { cwd: string, tsserverPath: string }) => Client
  Program: { prototype: { getDeclarationEmit?: unknown } }
}

interface Diagnostic {
  fileName?: string
  startPosition?: { line: number, character: number }
  code: number
  category: number
  text: string
  messageChain?: Diagnostic[]
}

interface Program {
  getSourceFileNames: () => Promise<readonly string[]>
  getDeclarationEmit: (files: readonly string[]) => Promise<{ emitSkipped: boolean, diagnostics: readonly Diagnostic[], outputFiles: ReadonlyMap<string, { text: string, sourceFileName?: string }> }>
  getSyntacticDiagnostics: (files: readonly string[]) => Promise<readonly Diagnostic[]>
  getSourceFile: (file: string) => Promise<{ text: string } | undefined>
}

interface Snapshot {
  getProjects: () => ReadonlyArray<{ program: Program }>
  update: (params: { fileNotifications: { changed?: string[], deleted?: string[] }, ensurePrograms: true }) => Promise<Snapshot>
  dispose: () => Promise<void>
}

interface Client {
  parseConfigFile: (file: string) => Promise<{ fileNames: string[], options: Record<string, unknown> }>
  createSnapshot: (params: { createPrograms: Array<{ rootFiles: string[], compilerOptions: Record<string, unknown> }> }) => Promise<Snapshot>
  close: () => Promise<void>
}

const CATEGORIES = ['warning', 'error', 'suggestion', 'message'] as const

function flatten(diagnostic: Diagnostic, indent = 0): string {
  return `${indent ? `\n${'  '.repeat(indent)}` : ''}${diagnostic.text}${(diagnostic.messageChain ?? []).map(child => flatten(child, indent + 1)).join('')}`
}

function engineDiagnostic(diagnostic: Diagnostic, kind: EngineDiagnostic['kind']): EngineDiagnostic {
  return {
    code: diagnostic.code,
    kind,
    category: CATEGORIES[diagnostic.category] ?? 'error',
    message: flatten(diagnostic),
    ...diagnostic.fileName && { file: normalize(diagnostic.fileName) },
    ...diagnostic.fileName && diagnostic.startPosition && { line: diagnostic.startPosition.line + 1, column: diagnostic.startPosition.character + 1 },
  }
}

const VERSION_RE = /^(\d+)\.(\d+)\./

function isAtLeast(version: string, [major, minor]: [number, number]) {
  const [, actualMajor, actualMinor] = version.match(VERSION_RE) ?? []
  return actualMajor !== undefined && (Number(actualMajor) > major || (Number(actualMajor) === major && Number(actualMinor) >= minor))
}

/** Whether the module in `cwd` has its own `typescript` at 7.1 or later, which has the native API. */
export function hasNativeTypescript(cwd: string): boolean {
  const manifest = installedManifest(cwd, 'typescript')
  const version = manifest && (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version
  return isAtLeast(version ?? '', NATIVE_PACKAGES[ENGINES.typescript].minimum)
}

/**
 * The native engine the module in `cwd` has installed, if any: its own `typescript` at 7.1 or
 * later, then `@typescript/typescript7`, then `tsrs`.
 */
export function installedNativeEngine(cwd: string): NativeEngineName | undefined {
  if (hasNativeTypescript(cwd)) {
    return ENGINES.typescript
  }
  return ([ENGINES.typescript7, ENGINES.tsrs] as const).find(engine => installedManifest(cwd, NATIVE_PACKAGES[engine].name))
}

/**
 * The `package.json` of the package installed as `name` in `node_modules` of `cwd` or a directory
 * above it, leaving out `NODE_PATH` and global folders, which hold packages the module didn't install.
 */
function installedManifest(cwd: string, name: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(manifest)) {
      return realpathSync(manifest)
    }
    if (dirname(dir) === dir) {
      return
    }
  }
}

/** Why the binaries of `engine` cannot run on a system whose `process.report` header is `header`, if they cannot. */
export function platformProblem(engine: NativeEngineName, header: { glibcVersionRuntime?: string } | undefined, platform: string = process.platform): string | undefined {
  const glibc = header?.glibcVersionRuntime
  if (engine === ENGINES.tsrs && platform === 'linux' && glibc && !isAtLeast(`${glibc}.0`, TSRS_GLIBC)) {
    return `its Linux binaries need glibc ${TSRS_GLIBC.join('.')}, and this system has glibc ${glibc}`
  }
}

function reportHeader() {
  try {
    return (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  }
  catch {
    return undefined
  }
}

interface NativePackage {
  dir: string
  version: string
  api: NativeApi
  exe: string
}

/** Finds the package of `engine` that the module in `cwd` resolves, and checks that it can run here. */
async function findPackage(cwd: string, engine: NativeEngineName): Promise<NativePackage> {
  const { name, package: packageName, minimum } = NATIVE_PACKAGES[engine]
  const candidates = [...new Set([packageName, name])].flatMap((candidate) => {
    const manifest = installedManifest(cwd, candidate)
    if (!manifest) {
      return []
    }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string, version?: string }
    return [{ name: candidate, manifest, found: `${pkg.name}@${pkg.version}`, usable: pkg.name === packageName && isAtLeast(pkg.version ?? '', minimum), version: pkg.version ?? '' }]
  })
  const usable = candidates.find(candidate => candidate.usable)
  if (!usable) {
    const installed = candidates.find(candidate => candidate.name === name) ?? candidates.find(candidate => isAtLeast(candidate.version, [minimum[0], 0]))
    if (installed) {
      throw new NativeEngineError(engine, 'version', `\`${installed.name}\` resolves to \`${installed.found}\`.`, { found: installed.found, installedAs: installed.name })
    }
    throw new NativeEngineError(engine, 'missing', `\`${name}\` is not installed.`)
  }
  const { manifest, version, found } = usable
  debug('the %s declaration engine uses %s, installed as %s', engine, found, usable.name)
  const dir = dirname(manifest)
  const api = await (async () => import(pathToFileURL(createRequire(manifest).resolve(`${packageName}/async`)).href))().catch(() => undefined) as NativeApi | undefined
  if (typeof api?.API !== 'function' || typeof api.Program?.prototype.getDeclarationEmit !== 'function') {
    throw new NativeEngineError(engine, 'api', `\`${found}\` does not have the declaration emit API of TypeScript 7.1`, { found, installedAs: usable.name })
  }
  const problem = platformProblem(engine, reportHeader())
  if (problem) {
    throw new NativeEngineError(engine, 'platform', problem)
  }
  let exe: string
  try {
    const { default: getExePath } = await import(pathToFileURL(join(dir, 'lib/getExePath.js')).href) as { default: () => string }
    exe = getExePath()
  }
  catch (error) {
    throw new NativeEngineError(engine, 'platform', `\`${packageName}@${version}\` has no binary for ${process.platform}-${process.arch} (${(error instanceof Error ? error.message : String(error)).split('\n')[0]})`, { cause: error })
  }
  const failure = await new Promise<string | undefined>((resolve) => {
    try {
      execFile(exe, ['--version'], { timeout: 30_000 }, (error, _stdout, stderr) => resolve(error ? (stderr.trim() || error.message) : undefined))
    }
    catch (error) {
      resolve(error instanceof Error ? error.message : String(error))
    }
  })
  if (failure) {
    throw new NativeEngineError(engine, 'platform', `its binary does not start (${failure.split('\n')[0]})`)
  }
  return { dir, version, api, exe }
}

interface OpenProject {
  snapshot: Snapshot
  create: () => Promise<Snapshot>
  /** What `snapshot` holds of the files outside `node_modules`, read from it on first use. */
  files?: Promise<SnapshotFiles>
}

interface SnapshotFiles {
  /** The text of each file. */
  contents: Map<string, string>
  /** The names in each directory of those files. */
  listings: Map<string, string>
}

const BOM_RE = /^\uFEFF/
const listingOf = (dir: string) => readdir(dir).then(names => names.sort().join('\0'), () => '')
const textOf = (file: string) => readFile(file, 'utf8').then(text => text.replace(BOM_RE, ''), () => undefined)

async function snapshotFiles(snapshot: Snapshot): Promise<SnapshotFiles> {
  const program = snapshot.getProjects()[0]!.program
  const files = (await program.getSourceFileNames()).map(file => normalize(file)).filter(file => !NODE_MODULES_RE.test(file))
  const texts = await Promise.all(files.map(async file => [file, (await program.getSourceFile(file))?.text] as const))
  const dirs = [...new Set(files.map(file => dirname(file)))]
  return {
    contents: new Map(texts.flatMap(([file, text]) => text === undefined ? [] : [[file, text.replace(BOM_RE, '')]])),
    listings: new Map(await Promise.all(dirs.map(async dir => [dir, await listingOf(dir)] as const))),
  }
}

/**
 * A native compiler with the TypeScript 7.1 API: `typescript` 7.1 or later, the module's own or
 * `@typescript/typescript7`, or `tsrs`. One process serves every program until `close`. A
 * program opened again with the same roots and options is kept, and updated with the files
 * outside `node_modules` whose text differs from what it read, or created again when a file was
 * added next to them. Throws a {@link NativeEngineError} when the engine
 * cannot be used.
 */
export async function createNativeEngine(cwd: string, engine: NativeEngineName): Promise<DeclarationEngine> {
  const { version, api, exe } = await findPackage(cwd, engine)
  let client: Client | undefined
  const projects = new Map<string, Promise<OpenProject>>()

  const refresh = async (open: OpenProject) => {
    const { contents, listings } = await (open.files ??= snapshotFiles(open.snapshot))
    const previous = open.snapshot
    const added = (await Promise.all([...listings].map(async ([dir, names]) => await listingOf(dir) !== names))).some(Boolean)
    if (added) {
      open.snapshot = await open.create()
    }
    else {
      const changed: string[] = []
      const deleted: string[] = []
      await Promise.all([...contents].map(async ([file, text]) => {
        const current = await textOf(file)
        if (current === undefined) {
          deleted.push(file)
        }
        else if (current !== text) {
          changed.push(file)
        }
      }))
      if (!changed.length && !deleted.length) {
        return
      }
      open.snapshot = await previous.update({ fileNotifications: { changed, deleted }, ensurePrograms: true })
    }
    open.files = undefined
    if (open.snapshot !== previous) {
      await previous.dispose()
    }
  }

  return {
    name: engine,
    version,
    async open({ tsconfig, include, roots, compilerOptions }: ProjectOptions): Promise<DeclarationProject> {
      client ??= new api.API({ cwd, tsserverPath: exe })
      const parsed = tsconfig ? await client.parseConfigFile(tsconfig) : undefined
      const rootNames = [...new Set([...(parsed?.fileNames ?? []).map(file => normalize(file)).filter(include), ...roots])]
      const options = JSON.parse(JSON.stringify({ ...parsed?.options, ...compilerOptions })) as Record<string, unknown>
      const id = JSON.stringify([rootNames, options])
      const existing = projects.get(id)
      const pending = existing
        ? existing.then(async (open) => {
            await refresh(open)
            return open
          })
        : (() => {
            const create = () => client!.createSnapshot({ createPrograms: [{ rootFiles: rootNames, compilerOptions: options }] })
            return create().then(snapshot => ({ snapshot, create }) as OpenProject)
          })()
      projects.set(id, pending)
      const opened = await pending
      const program = () => opened.snapshot.getProjects()[0]!.program
      const sourceFiles = async () => (await program().getSourceFileNames()).map(file => normalize(file))
      return {
        async inputs() {
          const { contents } = await (opened.files ??= snapshotFiles(opened.snapshot))
          return new Map((await sourceFiles()).map(file => [file, contents.get(file)]))
        },
        async emit(files) {
          const present = new Set(await sourceFiles())
          const requested = files.filter(file => present.has(file))
          const [output, syntactic] = requested.length ? await Promise.all([program().getDeclarationEmit(requested), program().getSyntacticDiagnostics(requested)]) : [undefined, []]
          const emitted = new Map<string, string>()
          for (const file of output?.outputFiles.values() ?? []) {
            if (file.sourceFileName) {
              emitted.set(normalize(file.sourceFileName), file.text)
            }
          }
          const all = [...syntactic.map(diagnostic => engineDiagnostic(diagnostic, 'syntactic')), ...(output?.diagnostics ?? []).map(diagnostic => engineDiagnostic(diagnostic, 'emit'))]
          const declarations = new Map<string, string>()
          const diagnostics: EngineDiagnostic[] = []
          for (const file of files) {
            const text = emitted.get(file)
            if (text !== undefined) {
              declarations.set(file, text)
            }
            diagnostics.push(...all.filter(diagnostic => diagnostic.file === file))
          }
          diagnostics.push(...all.filter(diagnostic => !diagnostic.file || !files.includes(diagnostic.file)))
          return { declarations, diagnostics }
        },
      }
    },
    async close() {
      const open = await Promise.all([...projects.values()].map(project => project.catch(() => undefined)))
      projects.clear()
      await Promise.all(open.map(project => project?.snapshot.dispose().catch(() => {})))
      await client?.close()
      client = undefined
    },
  }
}
