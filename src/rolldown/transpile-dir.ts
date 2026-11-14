import { readFile } from 'node:fs/promises'
import type { TsConfigResult } from 'get-tsconfig'
import { basename, dirname, join, normalize, relative, resolve } from 'pathe'
import { glob } from 'tinyglobby'
import type { Rolldown } from 'tsdown'

import type { Transform as VueTransform } from 'vue-sfc-transformer/core'

import { createDeclarationProgram, DeclarationError, declarationError, relativeSpecifier } from './declarations.ts'
import type { DeclarationProgram } from './declarations.ts'
import { DECLARATION_RE, moduleSpecifiers, probe, RELATIVE_RE, rewriteSpecifiers, SCRIPT_RE, scriptExtension, valueSpecifiers } from './resolve.ts'
import { compileSass, SASS_RE, transformCss } from './stylesheets.ts'
import { createTsconfigResolver, writeDerivedTsconfig } from './tsconfig.ts'
import { declarationPath, emitDeclarations, transformVueRuntime } from './vue.ts'
import type { VueDeclarations, VueOptions } from './vue.ts'

export interface TransformResult {
  code: string
  map?: object
  errors: Array<{ message: string }>
}

export interface TransformOptions {
  lang?: string
  sourcemap?: boolean
  jsx?: 'preserve' | { runtime?: 'automatic' | 'classic', importSource?: string }
  typescript?: { onlyRemoveTypeImports?: boolean }
}

/** The shape of `transform` from `rolldown/utils`. */
export type Transform = (filename: string, source: string, options?: TransformOptions) => Promise<TransformResult>

export type ImportKind = 'value' | 'type'

export interface ExternalImport {
  /** Absolute path of the file the specifier resolves to. */
  file: string
  /** Whether the import remains in the emitted script, or only its types are used. */
  kind: ImportKind
  /** Where the importer is emitted, relative to the output directory. */
  from: string
  /** Where the plugin would emit the file, relative to the output directory. */
  output: string
}

export interface MirrorExternal {
  /** Emit the file alongside the directory: as a script and declaration, or as a declaration only. */
  mirror: ImportKind
  /** Where to emit it, relative to the output directory. Defaults to the proposed `output`. */
  output?: string
}

/**
 * Decides what happens to a relative import that resolves outside `srcDir`: a replacement
 * specifier, a mirrored copy of the file, or `undefined` to keep the specifier as written.
 */
export type ResolveExternal = (specifier: string, importer: string, context: ExternalImport) => string | MirrorExternal | undefined | Promise<string | MirrorExternal | undefined>

export interface TranspileDirOptions {
  /** The directory whose files are transpiled one by one. */
  srcDir: string
  /** Where the outputs go, relative to the build's output directory. Defaults to its root. */
  outBase?: string
  /** The project root: where `srcDir` is resolved, the tsconfig search starts and `node_modules` is read. Defaults to the build's `cwd`. */
  cwd?: string
  /** Globs of files to include, relative to `srcDir`. Defaults to every file. */
  include?: string[]
  /** Globs of files to exclude. Defaults to test and story files. */
  exclude?: string[]
  /** The extension of emitted scripts; declarations follow (`.d.ts` or `.d.mts`). Defaults to `js`. */
  extension?: 'js' | 'mjs'
  /** The tsconfig to compile with, or `false` for none. Defaults to the nearest one above `cwd`. */
  tsconfig?: string | false
  /** `paths` added to the tsconfig's when generating declarations. */
  paths?: Record<string, string[]>
  /**
   * JSX compilation for `.tsx` and `.jsx` files, or a function of the source path that returns it.
   * Defaults to `'preserve'`, which emits them as `.jsx` with types stripped, next to a `.d.ts`,
   * for the consumer's JSX plugin (such as `@vitejs/plugin-vue-jsx`) to compile.
   */
  jsx?: TransformOptions['jsx'] | ((file: string) => TransformOptions['jsx'])
  /** The oxc `transform` to use. Defaults to the one of the `rolldown` installed. */
  transform?: Transform
  /** Emit source maps next to scripts. */
  sourcemap?: boolean
  /** Generate declarations. Defaults to `true`. */
  declaration?: boolean
  /** Process `.css` with lightningcss and compile Sass. Defaults to `true`; `false` copies stylesheets as they are. */
  stylesheets?: boolean
  /** Options for `.vue` files, or `false` to leave them out. */
  vue?: VueOptions | false
  /** Relative imports that resolve outside `srcDir`. By default they are kept as written. */
  resolveExternal?: ResolveExternal
}

export interface TranspileDirApi {
  /** Every discovered or mirrored source of the latest build, mapped to the path it is emitted at, relative to the output directory. */
  readonly outputs: Promise<Map<string, string>>
}

const EMPTY_ENTRY_ID = '\0transpile-dir:empty-entry'

/**
 * An entry for a build that has nothing to bundle, only directories to transpile. Pass it
 * as tsdown's `entry` (or rolldown's `input`); `transpileDir` resolves it to an empty module
 * and removes its chunk from the output.
 */
export const emptyEntry: Record<string, string> = { 'transpile-dir': EMPTY_ENTRY_ID }

/** `pluginCode` of the warning that lists type errors which do not affect the emitted declarations. */
export const TYPE_ERRORS_WARNING = 'TYPE_ERRORS'

type Warning = string | { pluginCode: string, message: string }

interface Edge {
  specifier: string
  target: string
  value: boolean
}

type Resolution = { specifier: string } | { target: string, kind: ImportKind, output?: string } | undefined

interface Emitted {
  fileName: string
  source: string | Uint8Array
  map?: { source: string, map: object }
}

const EMPTY_IMPORT_RE = /^[ \t]*import\s*\{\s*\}\s*from\s*(['"])[^'"\n]+\1\s*;?/gm
export const DEFAULT_EXCLUDE: string[] = ['**/*.{stories,spec,test}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/node_modules/**']
const STYLESHEET_RE = /\.(?:css|s[ac]ss)$/
const VUE_DECLARATION_RE = /\.(?:d\.vue\.ts|vue\.d\.ts)$/
const TYPESCRIPT_RE = /\.(?:[cm]?ts|tsx)$/

interface Emitter {
  /** Rewritten declarations keyed by source path. */
  emitted: Map<string, string>
  /** The program shared by single-file components and TypeScript sources, when the directory has components. */
  vue?: () => Promise<VueDeclarations>
  emit: (files: string[]) => Promise<void>
}

/**
 * Transpiles the files of a directory one by one: each script keeps its own imports and
 * exports, `.vue` files go through `vue-sfc-transformer`, stylesheets are processed, other
 * files are copied, and declarations come from one TypeScript program over the directory.
 */
export function transpileDir(options: TranspileDirOptions): Rolldown.Plugin & { api: TranspileDirApi } {
  let cwd = process.cwd()
  let resolveOutputs: (outputs: Map<string, string>) => void
  let rejectOutputs: (error: unknown) => void
  const outputs = new Promise<Map<string, string>>((resolve, reject) => {
    resolveOutputs = resolve
    rejectOutputs = reject
  })
  outputs.catch(() => {})
  let latestOutputs = outputs
  let work: Promise<{ build: DirectoryBuild, files: Emitted[] } | { error: unknown }> | undefined
  let latestBuild: DirectoryBuild | undefined

  return {
    name: 'transpile-dir',
    api: {
      get outputs() {
        return latestOutputs
      },
    },
    resolveId: {
      filter: { id: /^\0transpile-dir:empty-entry$/ },
      handler: id => id,
    },
    load: {
      filter: { id: /^\0transpile-dir:empty-entry$/ },
      handler: () => ({ code: 'export {}', moduleSideEffects: false }),
    },
    async buildStart(inputOptions) {
      cwd = resolve(inputOptions.cwd, options.cwd ?? '')
      const srcDir = resolve(cwd, options.srcDir)
      const files = await glob(options.include ?? ['**/*'], { cwd: srcDir, ignore: options.exclude ?? DEFAULT_EXCLUDE, absolute: true, onlyFiles: true })
      for (const file of files) {
        this.addWatchFile(file)
      }
      const build = latestBuild = new DirectoryBuild({ ...options, cwd, srcDir }, files.map(file => normalize(file)).sort())
      work = build.run()
        .then((files) => {
          resolveOutputs(build.outputs)
          return { build, files }
        })
        .catch((error) => {
          rejectOutputs(error)
          return { error }
        })
      latestOutputs = work.then(result => 'error' in result ? Promise.reject(result.error) : result.build.outputs)
      latestOutputs.catch(() => {})
    },
    async buildEnd() {
      await work
      for (const source of latestBuild?.outputs.keys() ?? []) {
        this.addWatchFile(source)
      }
    },
    async generateBundle(outputOptions, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk' && output.facadeModuleId === EMPTY_ENTRY_ID) {
          Reflect.deleteProperty(bundle, fileName)
        }
      }
      const result = await work!
      if ('error' in result) {
        this.error(result.error instanceof Error ? result.error : new Error(String(result.error)))
      }
      for (const warning of result.build.warnings) {
        this.warn(warning)
      }
      const outDir = resolve(cwd, outputOptions.dir ?? '')
      for (const { fileName, source, map } of result.files) {
        this.emitFile({ type: 'asset', fileName, source })
        if (map) {
          const sources = [relative(dirname(join(outDir, fileName)), map.source)]
          this.emitFile({ type: 'asset', fileName: `${fileName}.map`, source: JSON.stringify({ ...map.map, sources, file: basename(fileName) }) })
        }
      }
    },
  }
}

class DirectoryBuild {
  /** Source path to output path, relative to the output directory. */
  outputs = new Map<string, string>()
  warnings: Warning[] = []
  private typeErrors: string[] = []
  private scripts: string[] = []
  private vue: string[] = []
  private assets: string[] = []
  private outside = new Map<string, ImportKind>()
  private edges = new Map<string, Promise<Edge[]>>()
  private resolutions = new Map<string, Promise<Resolution>>()
  private references = new Map<string, Set<string>>()
  private transform: Promise<Transform> | undefined
  private extension: string
  private dtsExtension: string
  private outBase: string
  private options: TranspileDirOptions & { cwd: string, srcDir: string }

  constructor(options: TranspileDirOptions & { cwd: string, srcDir: string }, files: string[]) {
    this.options = options
    this.extension = `.${options.extension ?? 'js'}`
    this.dtsExtension = options.extension === 'mjs' ? '.d.mts' : '.d.ts'
    this.outBase = options.outBase ?? ''
    for (const file of files) {
      const path = join(this.outBase, relative(options.srcDir, file))
      if (file.endsWith('.vue')) {
        if (options.vue !== false) {
          this.vue.push(file)
          this.outputs.set(file, path)
        }
      }
      else if (SCRIPT_RE.test(file) && !DECLARATION_RE.test(file)) {
        this.scripts.push(file)
        this.outputs.set(file, path.replace(SCRIPT_RE, this.scriptExtension(file)))
      }
      else if (options.stylesheets === false) {
        this.assets.push(file)
        this.outputs.set(file, path)
      }
      else if (!(SASS_RE.test(file) && basename(file).startsWith('_'))) {
        this.assets.push(file)
        this.outputs.set(file, path.replace(SASS_RE, '.css'))
      }
    }
  }

  async run(): Promise<Emitted[]> {
    await this.plan()
    const valueFiles = [...this.outside].filter(([, kind]) => kind === 'value').map(([file]) => file)
    const emitter = this.options.declaration === false ? undefined : await this.createEmitter()
    const settled = await Promise.allSettled([
      Promise.all([...this.scripts, ...valueFiles].map(file => this.transpile(file))),
      Promise.all(this.assets.map(file => this.asset(file))),
      this.transformVue(emitter),
      emitter?.emit([...this.scripts, ...valueFiles]),
    ])
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (failures.length) {
      throw failures.every(failure => failure instanceof DeclarationError)
        ? declarationError([...new Set(failures.flatMap(failure => failure.diagnostics))])
        : failures.find(failure => !(failure instanceof DeclarationError))
    }
    const [scripts, assets, vue] = settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as [Emitted[], Emitted[], Emitted[]]
    const declarations: Emitted[] = []
    if (emitter) {
      const requested = new Set([...this.scripts, ...valueFiles])
      let referenced = this.referencedOutside([...this.scripts, ...valueFiles, ...this.vue], requested)
      while (referenced.length) {
        await emitter.emit(referenced)
        referenced = this.referencedOutside(referenced, requested)
      }
      for (const [source, text] of emitter.emitted) {
        declarations.push({ fileName: this.declarationOutput(source), source: text })
      }
    }
    if (this.typeErrors.length) {
      this.warnings.push({ pluginCode: TYPE_ERRORS_WARNING, message: typeErrorsWarning([...new Set(this.typeErrors)], relative(this.options.cwd, this.options.srcDir)) })
    }
    return [...scripts, ...assets, ...vue, ...declarations]
  }

  private jsx(file: string) {
    const { jsx } = this.options
    return (typeof jsx === 'function' ? jsx(file) : jsx) ?? 'preserve'
  }

  private scriptExtension(file: string) {
    return scriptExtension(file, this.extension, this.jsx(file) === 'preserve')
  }

  private declarationOutput(source: string) {
    const output = this.outputs.get(source)!
    return output.replace(SCRIPT_RE, output.endsWith('.jsx') ? '.d.ts' : this.dtsExtension)
  }

  private async plan() {
    const kinds = new Map<string, ImportKind>([...this.scripts, ...this.vue].map(file => [file, 'value']))
    const queue = [...kinds.keys()]
    const taken = new Set([...this.outputs.values()].map(stem))
    while (queue.length) {
      const importer = queue.shift()!
      const importerKind = kinds.get(importer)!
      for (const edge of await this.edgesOf(importer)) {
        if (this.outputs.has(edge.target) && !this.outside.has(edge.target)) {
          continue
        }
        const kind: ImportKind = importerKind === 'value' && edge.value ? 'value' : 'type'
        const from = this.outputs.get(importer)!
        const proposed = this.proposedOutput(importer, edge.target, taken)
        const result = await this.resolveExternal(edge, importer, { file: edge.target, kind, from, output: proposed })
        if (!result || !('target' in result)) {
          continue
        }
        const existing = this.outside.get(edge.target)
        if (existing === 'value' || existing === result.kind) {
          continue
        }
        if (!existing) {
          const output = result.output ?? proposed
          this.outputs.set(edge.target, output)
          taken.add(stem(output))
        }
        this.outside.set(edge.target, result.kind)
        kinds.set(edge.target, result.kind)
        queue.push(edge.target)
      }
    }
  }

  private resolveExternal(edge: Edge, importer: string, context: ExternalImport) {
    const key = `${importer}\0${edge.specifier}\0${context.kind}`
    let pending = this.resolutions.get(key)
    if (!pending) {
      pending = Promise.resolve(this.options.resolveExternal?.(edge.specifier, importer, context)).then((result): Resolution => {
        if (typeof result === 'string') {
          return { specifier: result }
        }
        if (result) {
          return { target: edge.target, kind: result.mirror, output: result.output }
        }
      })
      this.resolutions.set(key, pending)
    }
    return pending
  }

  /**
   * Where a file outside the directory goes: where the importer's relative specifier
   * already points, or under `_external/` (with `..` segments as `_`) when that leaves the
   * output directory or takes another output's name.
   */
  private proposedOutput(importer: string, target: string, taken: Set<string>) {
    const mirrored = stem(join(dirname(this.outputs.get(importer)!), relative(dirname(importer), target)))
    if (!mirrored.startsWith('..') && !taken.has(mirrored)) {
      return mirrored + this.scriptExtension(target)
    }
    const segments = stem(relative(this.options.cwd, target)).split('/').map(segment => segment === '..' ? '_' : segment)
    return join('_external', ...segments) + this.scriptExtension(target)
  }

  private edgesOf(importer: string) {
    let edges = this.edges.get(importer)
    if (!edges) {
      edges = this.readEdges(importer)
      this.edges.set(importer, edges)
    }
    return edges
  }

  private async readEdges(importer: string): Promise<Edge[]> {
    const source = await readFile(importer, 'utf8')
    const values = importer.endsWith('.vue') ? valueSpecifiers(source) : valueSpecifiers((await this.transpileSource(importer, source)).code)
    const edges: Edge[] = []
    const seen = new Set<string>()
    for (const { specifier } of moduleSpecifiers(source)) {
      if (!RELATIVE_RE.test(specifier) || seen.has(specifier)) {
        continue
      }
      seen.add(specifier)
      const target = probe(resolve(dirname(importer), specifier))
      if (target && SCRIPT_RE.test(target) && !DECLARATION_RE.test(target)) {
        edges.push({ specifier, target: normalize(target), value: values.has(specifier) })
      }
    }
    return edges
  }

  private loadTransform() {
    if (this.options.transform) {
      return this.options.transform
    }
    this.transform ??= import('rolldown/utils').then(utils => utils.transform as Transform, (cause) => {
      throw new Error('`transpileDir` needs `rolldown` to transpile scripts. Install it, or pass its `transform` in the `transform` option.', { cause })
    })
    return this.transform
  }

  private async transpileSource(file: string, source: string, sourcemap = false) {
    const transform = await this.loadTransform()
    const result = await transform(file, /\.[cm]?tsx?$/.test(file) ? source.replace(EMPTY_IMPORT_RE, match => ' '.repeat(match.length)) : source, {
      lang: file.match(/\.[cm]?([jt]sx?)$/)![1],
      sourcemap,
      jsx: this.jsx(file),
      typescript: { onlyRemoveTypeImports: false },
    })
    if (result.errors.length) {
      throw new Error(`Failed to transpile ${relative(this.options.cwd, file)}:\n${result.errors.map(error => error.message).join('\n')}`)
    }
    return result
  }

  private async transpile(file: string): Promise<Emitted> {
    const fileName = this.outputs.get(file)!
    const result = await this.transpileSource(file, await readFile(file, 'utf8'), this.options.sourcemap)
    const code = await this.rewriteSpecifiers(file, fileName, result.code)
    if (!this.options.sourcemap || !result.map) {
      return { fileName, source: code }
    }
    return { fileName, source: `${code}\n//# sourceMappingURL=${basename(fileName)}.map\n`, map: { source: file, map: result.map } }
  }

  /**
   * `code` of `source`, emitted at `output`, with relative specifiers pointing at planned
   * outputs. For declarations, the files referred to are recorded.
   */
  private async rewriteSpecifiers(source: string, output: string, code: string, declaration = false) {
    const replacements = new Map<string, string | undefined>()
    const referenced = new Set<string>()
    for (const { specifier } of moduleSpecifiers(code)) {
      if (!RELATIVE_RE.test(specifier) || replacements.has(specifier)) {
        continue
      }
      replacements.set(specifier, await this.replacement(source, specifier, output, referenced))
    }
    if (declaration) {
      this.references.set(source, referenced)
    }
    return rewriteSpecifiers(code, specifier => replacements.get(specifier))
  }

  private async replacement(source: string, specifier: string, output: string, referenced: Set<string>) {
    const target = probe(resolve(dirname(source), specifier))
    if (!target) {
      return
    }
    const file = normalize(target)
    referenced.add(file)
    for (const kind of ['value', 'type'] as const) {
      const resolution = await this.resolutions.get(`${source}\0${specifier}\0${kind}`)
      if (resolution && 'specifier' in resolution) {
        return resolution.specifier
      }
    }
    const planned = this.outputs.get(file)
    if (planned && !DECLARATION_RE.test(file) && (SCRIPT_RE.test(file) || file.endsWith('.vue') || SASS_RE.test(file))) {
      return relativeSpecifier(output, planned)
    }
  }

  private async asset(file: string): Promise<Emitted> {
    const fileName = this.outputs.get(file)!
    if (this.options.stylesheets !== false && STYLESHEET_RE.test(file)) {
      const source = SASS_RE.test(file)
        ? await compileSass(file, this.options.cwd)
        : await transformCss(file, this.options.cwd, message => this.warnings.push(message))
      return { fileName, source }
    }
    return { fileName, source: await readFile(file) }
  }

  private tsconfigs() {
    return this.options.tsconfig === false ? undefined : createTsconfigResolver(this.options.cwd, this.options.tsconfig)
  }

  private async transformVue(emitter: Emitter | undefined): Promise<Emitted[]> {
    if (!this.vue.length) {
      return []
    }
    const runtime = await transformVueRuntime(this.vue, await this.loadTransform() as VueTransform)
    const results: Promise<Emitted>[] = [...runtime].map(async ([file, source]) => {
      const fileName = this.outputs.get(file)!
      return { fileName, source: await this.rewriteSpecifiers(file, fileName, source) }
    })
    if (!emitter) {
      return Promise.all(results)
    }
    const { declarations, errors, warnings } = await emitter.vue!()
    const selected = new Set(this.vue)
    const errorMessages = errors.filter(({ file }) => file === undefined || selected.has(file)).map(({ message }) => message)
    for (const file of this.vue) {
      if (!declarations.has(declarationPath(file)) && !errors.some(error => error.file === file)) {
        errorMessages.push(`${relative(this.options.cwd, file)}: no declaration was emitted`)
      }
    }
    if (errorMessages.length) {
      throw declarationError([...new Set(errorMessages)])
    }
    this.typeErrors.push(...warnings.filter(({ file }) => file !== undefined && selected.has(file)).map(({ message }) => message))
    for (const [path, source] of declarations) {
      const vueFile = path.replace(VUE_DECLARATION_RE, '.vue')
      if (!selected.has(vueFile)) {
        continue
      }
      const output = this.outputs.get(vueFile)!.replace(/\.vue$/, path.slice(vueFile.length - '.vue'.length))
      results.push(this.rewriteSpecifiers(vueFile, output, source, true).then(source => ({ fileName: output, source })))
    }
    return Promise.all(results)
  }

  /**
   * Declarations for the directory's scripts. With single-file components present,
   * TypeScript sources join their program so that types imported from a component
   * resolve; other scripts get one program per tsconfig project.
   */
  private async createEmitter(): Promise<Emitter> {
    const resolver = await this.tsconfigs()
    const programs = new Map<string | undefined, Promise<DeclarationProgram>>()
    const programFor = (tsconfig: TsConfigResult | undefined) => {
      let program = programs.get(tsconfig?.path)
      if (!program) {
        program = createDeclarationProgram({ cwd: this.options.cwd, tsconfig, paths: this.options.paths ?? {} }, [...this.scripts, ...this.outside.keys()])
        programs.set(tsconfig?.path, program)
      }
      return program
    }
    let vue: Promise<VueDeclarations> | undefined
    const vueProgram = this.vue.length
      ? () => vue ??= (async () => {
          const tsconfig = resolver?.root
          return emitDeclarations([...this.vue, ...[...this.scripts, ...this.outside.keys()].filter(file => TYPESCRIPT_RE.test(file))], {
            ...this.options.vue || {},
            cwd: this.options.cwd,
            tsconfig: tsconfig && await writeDerivedTsconfig(this.options.cwd, tsconfig, this.options.paths ?? {}),
          })
        })()
      : undefined
    const emitted = new Map<string, string>()

    return {
      emitted,
      vue: vueProgram,
      emit: async (files: string[]) => {
        const errors: string[] = []
        const warnings: string[] = []
        const groups = new Map<Promise<DeclarationProgram>, string[]>()
        const shared: string[] = []
        for (const file of files) {
          if (vueProgram && TYPESCRIPT_RE.test(file)) {
            shared.push(file)
            continue
          }
          const program = programFor(resolver?.resolve(file))
          groups.set(program, [...groups.get(program) ?? [], file])
        }
        if (shared.length) {
          const result = await vueProgram!()
          const selected = new Set(shared)
          errors.push(...result.errors.filter(({ file }) => file !== undefined && selected.has(file)).map(({ message }) => message))
          warnings.push(...result.warnings.filter(({ file }) => file !== undefined && selected.has(file)).map(({ message }) => message))
          for (const file of shared) {
            const text = result.declarations.get(declarationPath(file))
            if (text === undefined) {
              if (!result.errors.some(error => error.file === file)) {
                errors.push(`${relative(this.options.cwd, file)}: no declaration was emitted`)
              }
              continue
            }
            emitted.set(file, await this.rewriteSpecifiers(file, this.declarationOutput(file), text, true))
          }
        }
        for (const [pending, groupFiles] of groups) {
          const result = await (await pending).emit(groupFiles)
          errors.push(...result.errors)
          warnings.push(...result.warnings)
          for (const [source, text] of result.declarations) {
            emitted.set(source, await this.rewriteSpecifiers(source, this.declarationOutput(source), text, true))
          }
        }
        if (errors.length) {
          throw declarationError([...new Set(errors)])
        }
        this.typeErrors.push(...warnings)
      },
    }
  }

  private referencedOutside(sources: string[], requested: Set<string>) {
    const referenced = new Set<string>()
    for (const source of sources) {
      for (const target of this.references.get(source) ?? []) {
        if (this.outside.has(target) && !requested.has(target)) {
          referenced.add(target)
          requested.add(target)
        }
      }
    }
    return [...referenced]
  }
}

function stem(path: string) {
  return path.replace(SCRIPT_RE, '')
}

const SHOWN_TYPE_ERRORS = 3

function typeErrorsWarning(diagnostics: string[], directory: string) {
  const hidden = diagnostics.length - SHOWN_TYPE_ERRORS
  return [
    `${diagnostics.length} type error${diagnostics.length === 1 ? ' was' : 's were'} reported while generating declarations for \`${directory}\`; the declarations were emitted. If the module's own type check (for example \`nuxt typecheck\` or \`vue-tsc --noEmit\`) passes, these come from build-time aliases typed as \`any\` during declaration generation and can be ignored.`,
    ...diagnostics.slice(0, SHOWN_TYPE_ERRORS),
    ...hidden > 0 ? [`... and ${hidden} more`] : [],
  ].join('\n')
}
