import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parseTsconfig } from 'get-tsconfig'
import { normalize } from 'pathe'
import type { UserConfig } from 'tsdown'

import builderPkg from '../../package.json' with { type: 'json' }
import { contentCache } from '../transpile/cache.ts'
import type { ContentCache } from '../transpile/cache.ts'
import { createDeclarationProgram, declarationError, restoreImports } from '../transpile/declarations.ts'
import type { DeclarationProgram } from '../transpile/declarations.ts'
import type { DeclarationEngine } from '../transpile/engine.ts'
import { DECLARATION_RE } from '../utils.ts'

/** The `Generator` interface of rolldown-plugin-dts. */
export type DeclarationGenerator = Required<Omit<Extract<NonNullable<Extract<UserConfig['dts'], object>['generator']>, object>, 'addFile'>>

type GeneratorResult = Awaited<ReturnType<DeclarationGenerator['emit']>>

export interface EntryDeclarationOptions {
  cwd: string
  /** The tsconfig and `compilerOptions` rolldown-plugin-dts is given. */
  tsconfig: string | false
  compilerOptions: Record<string, unknown>
  /** Extra key for the cache, for inputs it cannot see. */
  cacheVersion: string
  /** Whether the build is watched, which keeps the worker between builds. */
  watch: () => boolean
  /** The compiler, rolldown-plugin-dts's `tsc` emit by default. */
  engine?: DeclarationEngine
}

type Request = { type: 'emit', file: string } | { type: 'invalidate', file: string } | { type: 'inputs' }

type WorkerModules = Record<'dts' | 'tsc' | 'context' | 'typescript', string>

// Every file of the tsconfig is passed as `entries`, resolved as the program's roots are (with the
// platform's separators), so that one program has them all as roots and
// emits every declaration: ambient declarations such as `.nuxt/nuxt.d.ts` apply, and inferred types
// can be named by their package. The tsconfig is read again after a file changes, as a rebuild
// rewrites it.
const WORKER = `
import { parentPort, workerData } from 'node:worker_threads'
const [{ resolveOptions }, { tscEmit }, { createContext, invalidateContextFile }, { default: ts }, { dirname }] = await Promise.all([import(workerData.dts), import(workerData.tsc), import(workerData.context), import(workerData.typescript), import('node:path')])
const context = createContext()
let base
const resolveBase = () => {
  const resolved = resolveOptions(workerData.options)
  const entries = ts.parseJsonConfigFileContent(resolved.tsconfigRaw, ts.sys, resolved.tsconfig ? dirname(resolved.tsconfig) : resolved.cwd, undefined, undefined, undefined, resolved.languageContext.getExtraFileExtensions()).fileNames.map(file => ts.sys.resolvePath(file))
  return { tsconfig: resolved.tsconfig, tsconfigRaw: resolved.tsconfigRaw, build: resolved.tsc.build, incremental: resolved.tsc.incremental, cwd: resolved.cwd, sourcemap: resolved.sourcemap, typecheck: resolved.typecheck, languageContext: resolved.languageContext, context, entries }
}
${patchJsonDts}
parentPort.on('message', ({ id, request }) => {
  try {
    if (request.type === 'emit') {
      base ??= resolveBase()
      const result = tscEmit({ ...base, id: request.file })
      if (result.code && request.file.endsWith('.json')) {
        result.code = patchJsonDts(ts, result.code)
      }
      parentPort.postMessage({ id, result })
    }
    else if (request.type === 'invalidate') {
      invalidateContextFile(context, request.file)
      base = undefined
      parentPort.postMessage({ id })
    }
    else {
      const files = new Map()
      for (const program of context.programs) {
        for (const file of program.getSourceFiles()) {
          files.set(file.fileName, file.text)
        }
      }
      parentPort.postMessage({ id, result: [...files] })
    }
  }
  catch (error) {
    parentPort.postMessage({ id, error })
  }
})
`

/**
 * Adds a default export, and named exports for an object, to the declaration of a JSON module.
 * Runs in the worker, so it uses nothing from outside its body.
 */
function patchJsonDts(ts: typeof import('typescript'), code: string) {
  const statements = ts.createSourceFile('json.d.ts', code, ts.ScriptTarget.Latest).statements
  const exported = (node: import('typescript').Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const keyOf = (name: import('typescript').PropertyName | undefined) => name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined
  if (code.includes('declare const _exports')) {
    if (code.includes('declare const _exports: {') && !code.includes('\n}[];')) {
      const first = statements[0]
      const type = first && ts.isVariableStatement(first) ? first.declarationList.declarations[0]?.type : undefined
      const keys = type && ts.isTypeLiteralNode(type) ? type.members.flatMap(member => keyOf(member.name) ?? []) : []
      code += keys.map((key, index) => `declare let _${key.replaceAll(/[^\w$]/g, '_')}${index}: typeof _exports[${JSON.stringify(key)}]\nexport { _${key.replaceAll(/[^\w$]/g, '_')}${index} as ${JSON.stringify(key)} }`).join('\n')
    }
    return code
  }
  const names = new Map<string, string>()
  for (const statement of statements) {
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.set(declaration.name.text, declaration.name.text)
        }
      }
    }
    else if (ts.isModuleDeclaration(statement) && exported(statement) && ts.isIdentifier(statement.name)) {
      names.set(statement.name.text, statement.name.text)
    }
    else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (ts.isIdentifier(element.name)) {
          names.set(element.name.text, element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text)
        }
      }
    }
  }
  return `${code}\ndeclare namespace __json_default_export {\n  export { ${Array.from(names, ([name, local]) => name === local ? name : `${local} as ${name}`).join(', ')} }\n}\nexport { __json_default_export as default }`
}

function createWorker(modules: WorkerModules, options: Record<string, unknown>) {
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER)}`), { workerData: { ...modules, options } })
  worker.unref()
  const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: unknown) => void }>()
  let next = 0
  worker.on('message', ({ id, result, error }: { id: number, result?: unknown, error?: unknown }) => {
    const handler = pending.get(id)
    pending.delete(id)
    if (!pending.size) {
      worker.unref()
    }
    if (error) {
      handler?.reject(error)
    }
    else {
      handler?.resolve(result)
    }
  })
  let failure: unknown
  const fail = (error: unknown) => {
    failure ??= error
    for (const handler of pending.values()) {
      handler.reject(failure)
    }
    pending.clear()
  }
  worker.on('error', fail)
  worker.on('exit', code => fail(new Error(`The declaration worker exited with code ${code}.`)))
  return {
    get exited() {
      return failure !== undefined
    },
    call: <T>(request: Request) => new Promise<T>((resolve, reject) => {
      if (failure !== undefined) {
        reject(failure)
        return
      }
      const id = next++
      worker.ref()
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ id, request })
    }),
    terminate: () => worker.terminate(),
  }
}

function workerModules(): WorkerModules {
  const require = createRequire(import.meta.resolve('tsdown'))
  const dts = require.resolve('rolldown-plugin-dts')
  return {
    dts: pathToFileURL(dts).href,
    tsc: pathToFileURL(require.resolve('rolldown-plugin-dts/tsc')).href,
    context: pathToFileURL(require.resolve('rolldown-plugin-dts/tsc-context')).href,
    typescript: pathToFileURL(createRequire(dts).resolve('typescript')).href,
  }
}

/** What the declarations depend on besides the files the program reads. */
async function cacheKey(modules: WorkerModules, dtsOptions: Record<string, unknown>, cacheVersion: string) {
  const { resolveOptions } = await import(modules.dts) as { resolveOptions: (options: object) => { tsconfig?: string, tsconfigRaw: unknown, sourcemap: boolean } }
  const resolved = resolveOptions(dtsOptions)
  const require = createRequire(new URL(modules.dts))
  return {
    builder: builderPkg.version,
    dts: (require('rolldown-plugin-dts/package.json') as { version: string }).version,
    typescript: (require('typescript/package.json') as { version: string }).version,
    tsconfig: resolved.tsconfig,
    tsconfigRaw: resolved.tsconfigRaw,
    sourcemap: resolved.sourcemap,
    cacheVersion,
  }
}

interface Backend {
  /** Starts what the first emit needs, ahead of it. */
  start: () => void
  emit: (code: string, fileName: string) => Promise<GeneratorResult>
  /** The files the program of the latest emits read, when it is still available. */
  inputs: () => Promise<Map<string, string | undefined> | undefined>
  invalidate: (fileName: string) => void
  /** Called after each build. */
  release: () => Promise<void>
  close: () => Promise<void>
}

/** rolldown-plugin-dts's `tsc` emit in a worker thread, which a watched build keeps until `close`. */
function workerBackend(modules: WorkerModules, dtsOptions: Record<string, unknown>, watch: () => boolean): Backend {
  let worker: ReturnType<typeof createWorker> | undefined
  const start = () => {
    if (worker?.exited) {
      worker = undefined
    }
    return worker ??= createWorker(modules, dtsOptions)
  }
  return {
    start,
    emit: (_code, fileName) => start().call<GeneratorResult>({ type: 'emit', file: fileName }),
    async inputs() {
      return worker && !worker.exited ? new Map(await worker.call<Array<[string, string]>>({ type: 'inputs' })) : undefined
    },
    invalidate(fileName) {
      worker?.call({ type: 'invalidate', file: fileName }).catch(() => {})
    },
    async release() {
      if (!watch()) {
        await worker?.terminate()
        worker = undefined
      }
    },
    async close() {
      await worker?.terminate()
      worker = undefined
    },
  }
}

/**
 * A program of `engine` over every file of the tsconfig, and the requested files it doesn't include,
 * opened again for each build so the engine updates it. JSON modules, for which TypeScript 7 emits
 * an empty declaration, go to `json`.
 */
function engineBackend(options: EntryDeclarationOptions & { tsconfig: string, engine: DeclarationEngine }, json: () => Backend): Backend {
  let program: Promise<DeclarationProgram> | undefined
  let jsonBackend: Backend | undefined
  const roots = new Set<string>()
  const open = () => program ??= createDeclarationProgram({
    cwd: options.cwd,
    tsconfig: { path: options.tsconfig, config: parseTsconfig(options.tsconfig) },
    paths: options.compilerOptions.paths as Record<string, string[]>,
    engine: options.engine,
    include: () => true,
  }, [...roots])
  return {
    start() {},
    async emit(code, fileName) {
      const file = normalize(fileName)
      if (DECLARATION_RE.test(file)) {
        return { code }
      }
      if (file.endsWith('.json')) {
        return (jsonBackend ??= json()).emit(code, fileName)
      }
      let result = await (await open()).emit([file])
      if (!result.declarations.has(file) && !roots.has(file)) {
        roots.add(file)
        program = undefined
        result = await (await open()).emit([file])
      }
      const { declarations, errors } = result
      const declaration = declarations.get(file)
      return errors.length || declaration === undefined ? { error: declarationError(errors).message } : { code: declaration }
    },
    async inputs() {
      const [own, fromJson] = await Promise.all([program && (await program).inputs(), jsonBackend?.inputs()])
      return own && (jsonBackend ? fromJson && new Map([...own, ...fromJson]) : own)
    },
    invalidate(fileName) {
      program = undefined
      jsonBackend?.invalidate(fileName)
    },
    async release() {
      program = undefined
      await jsonBackend?.release()
    },
    async close() {
      program = undefined
      await jsonBackend?.close()
    },
  }
}

/**
 * The declaration generator of the bundled entries: rolldown-plugin-dts's `tsc` emit in a worker
 * thread, or a program of `engine`. The declarations of a build are kept in the module's cache
 * and reused, without a program, while none of the files that build's program read have changed.
 */
export function entryDeclarationGenerator(options: EntryDeclarationOptions): DeclarationGenerator & { close: () => Promise<void> } {
  let backend: Backend | undefined
  let cache: ContentCache<Record<string, GeneratorResult>> | undefined
  let cached: Map<string, GeneratorResult> | undefined
  let emitted = new Map<string, GeneratorResult>()
  let mixed = false
  let invalidated = false
  const dtsOptions = { cwd: options.cwd, tsconfig: options.tsconfig, compilerOptions: options.compilerOptions, generator: 'tsc' }

  return {
    async init() {
      if (!cache) {
        const modules = workerModules()
        const { engine, tsconfig } = options
        const worker = () => workerBackend(modules, dtsOptions, options.watch)
        backend = engine && tsconfig ? engineBackend({ ...options, tsconfig, engine }, worker) : worker()
        const key = await cacheKey(modules, dtsOptions, options.cacheVersion)
        cache = contentCache(options.cwd, 'entry-declarations', engine ? { ...key, engine: engine.name, version: engine.version } : key)
        const stored = await cache.read()
        cached = stored && new Map(Object.entries(stored))
      }
      if (!cached) {
        backend!.start()
      }
    },
    async emit(code, fileName) {
      const hit = cached?.get(fileName)
      if (hit) {
        mixed = true
        return hit
      }
      const result = await backend!.emit(code, fileName)
      if (result.error) {
        mixed = true
      }
      else {
        if (result.code !== undefined && !fileName.endsWith('.json')) {
          result.code = await restoreImports(result.code, fileName, code)
        }
        emitted.set(fileName, result)
      }
      return result
    },
    async dispose() {
      const inputs = emitted.size && !mixed && !invalidated ? await backend?.inputs() : undefined
      if (inputs) {
        await cache!.write(Object.fromEntries(emitted), inputs)
      }
      emitted = new Map()
      mixed = false
      await backend?.release()
    },
    invalidate(fileName) {
      invalidated = true
      cached = undefined
      backend?.invalidate(fileName)
    },
    async close() {
      await backend?.close()
    },
  }
}
