import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { UserConfig } from 'tsdown'

/** The `Generator` interface of rolldown-plugin-dts. */
export type DeclarationGenerator = Required<Omit<Extract<NonNullable<Extract<UserConfig['dts'], object>['generator']>, object>, 'addFile'>>

type GeneratorResult = Awaited<ReturnType<DeclarationGenerator['emit']>>

export interface EntryDeclarationOptions {
  cwd: string
  /** The tsconfig and `compilerOptions` rolldown-plugin-dts is given. */
  tsconfig: string | false
  compilerOptions: Record<string, unknown>
  /** Whether the build is watched, which keeps the worker between builds. */
  watch: () => boolean
}

type Request = { type: 'emit', file: string } | { type: 'invalidate', file: string }

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
    else {
      invalidateContextFile(context, request.file)
      base = undefined
      parentPort.postMessage({ id })
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

/**
 * The declaration generator of the bundled entries: rolldown-plugin-dts's `tsc` emit in a worker
 * thread, which a watched build keeps until `close`.
 */
export function entryDeclarationGenerator(options: EntryDeclarationOptions): DeclarationGenerator & { close: () => Promise<void> } {
  let worker: ReturnType<typeof createWorker> | undefined
  const dtsOptions = { cwd: options.cwd, tsconfig: options.tsconfig, compilerOptions: options.compilerOptions, generator: 'tsc' }

  return {
    async init() {
      if (worker?.exited) {
        worker = undefined
      }
      worker ??= createWorker(workerModules(), dtsOptions)
    },
    async emit(_code, fileName) {
      return worker!.call<GeneratorResult>({ type: 'emit', file: fileName })
    },
    async dispose() {
      if (!options.watch()) {
        await worker?.terminate()
        worker = undefined
      }
    },
    invalidate(fileName) {
      worker?.call({ type: 'invalidate', file: fileName }).catch(() => {})
    },
    async close() {
      await worker?.terminate()
      worker = undefined
    },
  }
}
