import { readFile } from 'node:fs/promises'
import type { TsConfigResult } from 'get-tsconfig'
import { basename, dirname, join, normalize, relative, resolve } from 'pathe'
import { glob } from 'tinyglobby'
import type { Rolldown } from 'tsdown'

import type { VueDeclarationSession, Transform as VueTransform } from 'vue-sfc-transformer/core'

import { getOrCreate, isSourceScript, probe, RELATIVE_RE, relativeSpecifier, SCRIPT_RE, TYPESCRIPT_RE } from '../utils.ts'
import { createDeclarationProgram, DeclarationError, declarationError } from './declarations.ts'
import type { DeclarationProgram } from './declarations.ts'
import { moduleSpecifiers, rewriteSpecifiers, scriptExtension, valueSpecifiers } from './specifiers.ts'
import { compileSass, SASS_RE, transformCss } from './stylesheets.ts'
import { createTsconfigResolver, typeResolutionFs, writeDependencyImports, writeDerivedTsconfig } from './tsconfig.ts'
import type { TsconfigResolver } from './tsconfig.ts'
import { createDeclarationSession, declarationPath, emitDeclarations, transformVueRuntime } from './vue.ts'
import type { VueDeclarations } from './vue.ts'

interface TransformResult {
  code: string
  map?: object
  errors: Array<{ message: string }>
}

interface TransformOptions {
  lang?: string
  sourcemap?: boolean
  jsx?: 'preserve' | { runtime?: 'automatic' | 'classic', importSource?: string }
  typescript?: { onlyRemoveTypeImports?: boolean }
  tsconfig?: string
}

/** The shape of `transform` from `rolldown/utils`. */
export type Transform = (filename: string, source: string, options?: TransformOptions) => Promise<TransformResult>

type ImportKind = 'value' | 'type'

export interface ExternalImport {
  /** Absolute path of the file the specifier resolves to. */
  file: string
  /** Whether the import remains in the emitted script, or only its types are used. */
  kind: ImportKind
  /** Where the importer is emitted, relative to the output directory. */
  from: string
}

/**
 * Decides what happens to a relative import that resolves outside `srcDir`: a replacement
 * specifier, a mirrored copy of the file (as a script and declaration, or as a declaration
 * only), or `undefined` to keep the specifier as written.
 */
export type ResolveExternal = (specifier: string, importer: string, context: ExternalImport) => string | { mirror: ImportKind } | undefined

export interface TranspileDirOptions {
  /** Absolute path of the directory whose files are transpiled one by one. */
  srcDir: string
  /** Where the outputs go, relative to the build's output directory. */
  outBase: string
  /** The module root: where the tsconfig search starts and `node_modules` is read. */
  cwd: string
  /** The extension of emitted scripts; declarations follow (`.d.ts` or `.d.mts`). */
  extension: 'js' | 'mjs'
  /** `paths` added to the tsconfig's when generating declarations. */
  paths: Record<string, string[]>
  /**
   * JSX compilation for a `.tsx` or `.jsx` source. `'preserve'` emits it as `.jsx` with types
   * stripped, next to a `.d.ts`, for the app's JSX plugin to compile.
   */
  jsx: (file: string) => NonNullable<TransformOptions['jsx']>
  /** The oxc `transform` of the `rolldown` that tsdown runs. */
  transform: Transform
  /** Emit source maps next to scripts. */
  sourcemap: boolean
  /** Extra key for the declaration cache of single-file components, for inputs the cache cannot see. */
  cacheVersion: string
  /** Relative imports that resolve outside `srcDir`. */
  resolveExternal: ResolveExternal
  /** Paths relative to the output directory, without extension, that mirrored files are not emitted at. */
  reserved: string[]
  /** The plugin's name, which rolldown prints with its errors. `transpile-dir` by default. */
  name?: string
}

/** `pluginCode` of the warning that lists type errors which do not affect the emitted declarations. */
export const TYPE_ERRORS_WARNING = 'TYPE_ERRORS'

type Warning = string | { pluginCode: string, message: string }

interface Edge {
  specifier: string
  target: string
  value: boolean
}

interface Emitted {
  fileName: string
  source: string | Uint8Array
  map?: { source: string, map: object }
}

const EMPTY_IMPORT_RE = /^[ \t]*import\s*\{\s*\}\s*from\s*(['"])[^'"\n]+\1\s*;?/gm
export const EXCLUDE: string[] = ['**/*.{stories,spec,test}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/node_modules/**']
const STYLESHEET_RE = /\.(?:css|s[ac]ss)$/
const VUE_DECLARATION_RE = /\.(?:d\.vue\.ts|vue\.d\.ts)$/

/**
 * Transpiles the files of a directory one by one: each script keeps its own imports and
 * exports, `.vue` files go through `vue-sfc-transformer`, stylesheets are processed, other
 * files are copied, and declarations come from one TypeScript program over the directory.
 * `api.outputs` maps every discovered or mirrored source of the latest build to the path it
 * is emitted at, relative to the output directory. Under watch, the declaration program of
 * single-file components reuses the sources the previous build parsed, until the watcher closes.
 */
export function transpileDir(options: TranspileDirOptions): Rolldown.Plugin & { api: { readonly outputs: Promise<Map<string, string>> } } {
  let work: Promise<{ build: DirectoryBuild, files: Emitted[] } | { error: unknown }> | undefined
  let latestBuild: DirectoryBuild | undefined
  let session: Promise<VueDeclarationSession> | undefined

  return {
    name: options.name ?? 'transpile-dir',
    api: {
      get outputs() {
        return work!.then(result => 'error' in result ? Promise.reject(result.error) : result.build.outputs)
      },
    },
    async buildStart() {
      const files = await glob(['**/*'], { cwd: options.srcDir, ignore: EXCLUDE, absolute: true, onlyFiles: true })
      for (const file of files) {
        this.addWatchFile(file)
      }
      const build = latestBuild = new DirectoryBuild(options, files.map(file => normalize(file)).sort(), this.meta.watchMode ? () => session ??= createDeclarationSession() : undefined)
      work = build.run().then(files => ({ build, files }), (error: unknown) => ({ error }))
    },
    async buildEnd() {
      await work
      for (const source of latestBuild?.outputs.keys() ?? []) {
        this.addWatchFile(source)
      }
    },
    async generateBundle(outputOptions) {
      const result = await work!
      if ('error' in result) {
        this.error(result.error instanceof Error ? result.error : new Error(String(result.error)))
      }
      for (const warning of result.build.warnings) {
        this.warn(warning)
      }
      const outDir = resolve(options.cwd, outputOptions.dir ?? '')
      for (const { fileName, source, map } of result.files) {
        this.emitFile({ type: 'asset', fileName, source })
        if (map) {
          const sources = [relative(dirname(join(outDir, fileName)), map.source)]
          this.emitFile({ type: 'asset', fileName: `${fileName}.map`, source: JSON.stringify({ ...map.map, sources, file: basename(fileName) }) })
        }
      }
    },
    closeWatcher() {
      session = undefined
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
  private resolutions = new Map<string, ReturnType<ResolveExternal>>()
  private references = new Map<string, Set<string>>()
  /** Rewritten declarations keyed by source path. */
  private declarations = new Map<string, string>()
  private programs = new Map<string | undefined, Promise<DeclarationProgram>>()
  private vueDeclarations: Promise<VueDeclarations> | undefined
  private resolver!: TsconfigResolver
  private imports: string | undefined
  private extension: string
  private dtsExtension: string
  private options: TranspileDirOptions
  private session: (() => Promise<VueDeclarationSession>) | undefined

  constructor(options: TranspileDirOptions, files: string[], session?: () => Promise<VueDeclarationSession>) {
    this.options = options
    this.session = session
    this.extension = `.${options.extension}`
    this.dtsExtension = options.extension === 'mjs' ? '.d.mts' : '.d.ts'
    for (const file of files) {
      const path = join(options.outBase, relative(options.srcDir, file))
      if (file.endsWith('.vue')) {
        this.vue.push(file)
        this.outputs.set(file, path)
      }
      else if (isSourceScript(file)) {
        this.scripts.push(file)
        this.outputs.set(file, path.replace(SCRIPT_RE, this.scriptExtension(file)))
      }
      else if (!(SASS_RE.test(file) && basename(file).startsWith('_'))) {
        this.assets.push(file)
        this.outputs.set(file, path.replace(SASS_RE, '.css'))
      }
    }
  }

  async run(): Promise<Emitted[]> {
    this.resolver = await createTsconfigResolver(this.options.cwd)
    await this.plan()
    this.imports = await writeDependencyImports(this.options.cwd, this.resolver.root)
    const scripts = [...this.scripts, ...[...this.outside].filter(([, kind]) => kind === 'value').map(([file]) => file)]
    const settled = await Promise.allSettled([
      Promise.all(scripts.map(file => this.transpile(file))),
      Promise.all(this.assets.map(file => this.asset(file))),
      this.transformVue(),
      this.emitDeclarations(scripts),
    ])
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (failures.length) {
      throw failures.every(failure => failure instanceof DeclarationError)
        ? declarationError([...new Set(failures.flatMap(failure => failure.diagnostics))])
        : failures.find(failure => !(failure instanceof DeclarationError))
    }
    const [transpiled, assets, vue] = settled.map(result => (result as PromiseFulfilledResult<unknown>).value) as [Emitted[], Emitted[], Emitted[]]
    const requested = new Set(scripts)
    let referenced = this.referencedOutside([...scripts, ...this.vue], requested)
    while (referenced.length) {
      await this.emitDeclarations(referenced)
      referenced = this.referencedOutside(referenced, requested)
    }
    const declarations = [...this.declarations].map(([source, text]) => ({ fileName: this.declarationOutput(source), source: text }))
    if (this.typeErrors.length) {
      this.warnings.push({ pluginCode: TYPE_ERRORS_WARNING, message: typeErrorsWarning([...new Set(this.typeErrors)], relative(this.options.cwd, this.options.srcDir)) })
    }
    return [...transpiled, ...assets, ...vue, ...declarations]
  }

  private scriptExtension(file: string) {
    return scriptExtension(file, this.extension, this.options.jsx(file) === 'preserve')
  }

  private declarationOutput(source: string) {
    const output = this.outputs.get(source)!
    return output.replace(SCRIPT_RE, output.endsWith('.jsx') ? '.d.ts' : this.dtsExtension)
  }

  private async plan() {
    const queue = [...this.scripts, ...this.vue]
    const taken = new Set([...[...this.outputs.values()].map(stem), ...this.options.reserved])
    while (queue.length) {
      const importer = queue.shift()!
      const importerKind = this.outside.get(importer) ?? 'value'
      for (const edge of await getOrCreate(this.edges, importer, () => this.readEdges(importer))) {
        if (this.outputs.has(edge.target) && !this.outside.has(edge.target)) {
          continue
        }
        const kind: ImportKind = importerKind === 'value' && edge.value ? 'value' : 'type'
        const context = { file: edge.target, kind, from: this.outputs.get(importer)! }
        const result = getOrCreate(this.resolutions, `${importer}\0${edge.specifier}\0${kind}`, () => this.options.resolveExternal(edge.specifier, importer, context))
        const existing = this.outside.get(edge.target)
        if (!result || typeof result === 'string' || existing === 'value' || existing === result.mirror) {
          continue
        }
        if (!existing) {
          const output = this.proposedOutput(importer, edge.target, taken)
          this.outputs.set(edge.target, output)
          taken.add(stem(output))
        }
        this.outside.set(edge.target, result.mirror)
        queue.push(edge.target)
      }
    }
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

  private async readEdges(importer: string): Promise<Edge[]> {
    const source = await readFile(importer, 'utf8')
    const values = valueSpecifiers(importer.endsWith('.vue') ? source : (await this.transpileSource(importer, source)).code, importer)
    const specifiers = new Set(moduleSpecifiers(source, importer).map(({ specifier }) => specifier).filter(specifier => RELATIVE_RE.test(specifier)))
    return [...specifiers].flatMap((specifier) => {
      const target = probe(resolve(dirname(importer), specifier))
      return target && isSourceScript(target) ? [{ specifier, target: normalize(target), value: values.has(specifier) }] : []
    })
  }

  private async transpileSource(file: string, source: string, sourcemap = false) {
    const project = this.resolver.resolve(file)
    const result = await this.options.transform(file, TYPESCRIPT_RE.test(file) ? source.replace(EMPTY_IMPORT_RE, match => ' '.repeat(match.length)) : source, {
      lang: file.match(/\.[cm]?([jt]sx?)$/)![1],
      sourcemap,
      jsx: this.options.jsx(file),
      typescript: { onlyRemoveTypeImports: false },
      ...project && project !== this.resolver.root && { tsconfig: project.path },
    })
    if (result.errors.length) {
      throw new Error(`Failed to transpile ${relative(this.options.cwd, file)}:\n${result.errors.map(error => error.message).join('\n')}`)
    }
    return result
  }

  private async transpile(file: string): Promise<Emitted> {
    const fileName = this.outputs.get(file)!
    const result = await this.transpileSource(file, await readFile(file, 'utf8'), this.options.sourcemap)
    const code = this.rewriteSpecifiers(file, fileName, result.code)
    if (!this.options.sourcemap || !result.map) {
      return { fileName, source: code }
    }
    return { fileName, source: `${code}\n//# sourceMappingURL=${basename(fileName)}.map\n`, map: { source: file, map: result.map } }
  }

  /**
   * `code` of `source`, emitted at `output`, with relative specifiers pointing at planned
   * outputs. For declarations, the files referred to are recorded.
   */
  private rewriteSpecifiers(source: string, output: string, code: string, declaration = false) {
    const referenced = new Set<string>()
    const rewritten = rewriteSpecifiers(code, specifier => RELATIVE_RE.test(specifier) ? this.replacement(source, specifier, output, referenced) : undefined, output)
    if (declaration) {
      this.references.set(source, referenced)
    }
    return rewritten
  }

  private replacement(source: string, specifier: string, output: string, referenced: Set<string>) {
    const target = probe(resolve(dirname(source), specifier))
    if (!target) {
      return
    }
    const file = normalize(target)
    referenced.add(file)
    for (const kind of ['value', 'type'] as const) {
      const resolution = this.resolutions.get(`${source}\0${specifier}\0${kind}`)
      if (typeof resolution === 'string') {
        return resolution
      }
    }
    const planned = this.outputs.get(file)
    if (planned && (isSourceScript(file) || file.endsWith('.vue') || SASS_RE.test(file))) {
      return relativeSpecifier(output, planned)
    }
  }

  private async asset(file: string): Promise<Emitted> {
    const fileName = this.outputs.get(file)!
    if (STYLESHEET_RE.test(file)) {
      const source = SASS_RE.test(file)
        ? await compileSass(file, this.options.cwd)
        : await transformCss(file, this.options.cwd, message => this.warnings.push(message))
      return { fileName, source }
    }
    return { fileName, source: await readFile(file) }
  }

  private async transformVue(): Promise<Emitted[]> {
    if (!this.vue.length) {
      return []
    }
    const runtime = await transformVueRuntime(this.vue, this.options.transform as VueTransform, await typeResolutionFs(this.vue, file => this.resolver.resolve(file)))
    const result = await this.vueProgram()
    const { errors, warnings } = vueEmit(result, this.vue, this.options.cwd, true)
    if (errors.length) {
      throw declarationError([...new Set(errors)])
    }
    this.typeErrors.push(...warnings)
    const selected = new Set(this.vue)
    const declarations = [...result.declarations].flatMap(([path, source]) => {
      const vueFile = path.replace(VUE_DECLARATION_RE, '.vue')
      if (!selected.has(vueFile)) {
        return []
      }
      const fileName = this.outputs.get(vueFile)!.replace(/\.vue$/, path.slice(vueFile.length - '.vue'.length))
      return [{ fileName, source: this.rewriteSpecifiers(vueFile, fileName, source, true) }]
    })
    return [...[...runtime].map(([file, source]) => {
      const fileName = this.outputs.get(file)!
      return { fileName, source: this.rewriteSpecifiers(file, fileName, source) }
    }), ...declarations]
  }

  private program(tsconfig: TsConfigResult | undefined) {
    return getOrCreate(this.programs, tsconfig?.path, () => createDeclarationProgram({ cwd: this.options.cwd, tsconfig, paths: this.options.paths, cache: 'directory-declarations' }, [...this.scripts, ...this.outside.keys(), ...this.imports ? [this.imports] : []]))
  }

  /** The program shared by single-file components and TypeScript sources. */
  private vueProgram() {
    return this.vueDeclarations ??= (async () => {
      const tsconfig = this.resolver.root
      return emitDeclarations([...this.vue, ...[...this.scripts, ...this.outside.keys()].filter(file => TYPESCRIPT_RE.test(file))], {
        cwd: this.options.cwd,
        cacheVersion: this.options.cacheVersion,
        tsconfig: tsconfig && await writeDerivedTsconfig(this.options.cwd, tsconfig, this.options.paths, { vue: true, imports: this.imports }),
        session: await this.session?.(),
      })
    })()
  }

  /**
   * Declarations for `files`. With single-file components present, TypeScript sources join
   * their program so that types imported from a component resolve; other scripts get one
   * program per tsconfig project.
   */
  private async emitDeclarations(files: string[]) {
    const isShared = (file: string) => this.vue.length > 0 && TYPESCRIPT_RE.test(file)
    const shared = files.filter(isShared)
    const groups = new Map<Promise<DeclarationProgram>, string[]>()
    for (const file of files.filter(file => !isShared(file))) {
      const program = this.program(this.resolver.resolve(file))
      groups.set(program, [...groups.get(program) ?? [], file])
    }
    const results = shared.length ? [vueEmit(await this.vueProgram(), shared, this.options.cwd, false)] : []
    for (const [program, groupFiles] of groups) {
      results.push(await (await program).emit(groupFiles))
    }
    for (const [source, text] of results.flatMap(result => [...result.declarations])) {
      this.declarations.set(source, this.rewriteSpecifiers(source, this.declarationOutput(source), text, true))
    }
    const errors = results.flatMap(result => result.errors)
    if (errors.length) {
      throw declarationError([...new Set(errors)])
    }
    this.typeErrors.push(...results.flatMap(result => result.warnings))
  }

  private referencedOutside(sources: string[], requested: Set<string>) {
    const referenced = [...new Set(sources.flatMap(source => [...this.references.get(source) ?? []]))]
      .filter(target => this.outside.has(target) && !requested.has(target))
    for (const target of referenced) {
      requested.add(target)
    }
    return referenced
  }
}

/**
 * The declarations of `files` in `result`, keyed by source path, the diagnostics about them,
 * and an error for each of them without a declaration or an error of its own. With `global`,
 * errors that name no file are included.
 */
function vueEmit(result: VueDeclarations, files: string[], cwd: string, global: boolean) {
  const { errors, warnings } = result
  const selected = new Set(files)
  const about = ({ file }: { file?: string }) => file === undefined ? global : selected.has(file)
  const declarations = new Map(files.flatMap((file) => {
    const text = result.declarations.get(declarationPath(file))
    return text === undefined ? [] : [[file, text] as const]
  }))
  return {
    declarations,
    errors: [
      ...errors.filter(about).map(({ message }) => message),
      ...files.filter(file => !declarations.has(file) && !errors.some(error => error.file === file)).map(file => `${relative(cwd, file)}: no declaration was emitted`),
    ],
    warnings: warnings.filter(({ file }) => file !== undefined && selected.has(file)).map(({ message }) => message),
  }
}

function stem(path: string) {
  return path.replace(SCRIPT_RE, '')
}

const SHOWN_TYPE_ERRORS = 3

function typeErrorsWarning(diagnostics: string[], directory: string) {
  const hidden = diagnostics.length - SHOWN_TYPE_ERRORS
  return [
    `${diagnostics.length} type error${diagnostics.length === 1 ? ' was' : 's were'} reported while generating declarations for \`${directory}\`; the declarations were emitted.`,
    ...diagnostics.slice(0, SHOWN_TYPE_ERRORS),
    ...hidden > 0 ? [`... and ${hidden} more`] : [],
  ].join('\n')
}
