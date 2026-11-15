# Upgrading to @nuxt/module-builder v2

This guide takes a Nuxt module from v1 to v2 of the module builder. In v2, `@nuxt/module-builder` builds your module with [tsdown](https://tsdown.dev) instead of unbuild. The CLI, the project layout (`src/module.ts` and `src/runtime/`), and the output of your build stay the same.

Most modules upgrade by running the build and following its output. Every message that requires a change links to the matching section of this guide. If you'd rather work through everything up front, use the [checklist](#checklist) at the end.

## Node engines

v2 requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`. Use Node 22.18+, 24.11+, or 26+ locally and in CI:

```yaml
# .github/workflows/ci.yml
strategy:
  matrix:
    node: [22, 24]
```

## Install tsdown

`tsdown` is a peer dependency, so you install it alongside `@nuxt/module-builder`. Install both before you change `build.config.ts`: the `defineBuildConfig` export that the next section imports only exists in v2.

```bash
pnpm add -D @nuxt/module-builder@^2.0.0 tsdown@^0.23.7
```

```json
{
  "devDependencies": {
    "@nuxt/module-builder": "^2.0.0",
    "tsdown": "^0.23.7"
  }
}
```

Then remove the packages that you don't need any more (see [Removed dependencies](#removed-dependencies)).

## Build configuration

The build is configured in a `tsdown.config.ts` in the module root, with the options of the `builder()` plugin and of tsdown itself. See [tsdown config](#tsdown-config). Without the file, `nuxt-module-build build` builds `src/module` and `src/runtime` on its own, but `tsdown` needs it to build the module.

`build.config.ts` and the `unbuild` field of `package.json` are deprecated. Move their options to `tsdown.config.ts` as described in [Moving from build.config.ts](#moving-from-buildconfigts). Until then, the build reads them when there's no `tsdown.config.ts`, and applies these options:

- `entries`: bundled entries and directory entries, in the shapes described below.
- `externals`: package names and regular expressions that are never bundled.
- `replace` and `rollup.replace`: compile-time replacements in the module entry.
- `sourcemap`: `true` emits source maps next to the output.
- `hooks['build:before']`, `hooks['rollup:done']`, and `hooks['build:done']`: run with the context described in [Hooks](#hooks).
- `declaration`, `failOnWarn`, `name`, and `parallel`: accepted and ignored. `clean: true`, and `rootDir` and `outDir` at their defaults, are accepted too.

`unbuild` is no longer installed with `@nuxt/module-builder`. After [installing v2](#install-tsdown), change the import:

```ts
// build.config.ts, before
import { defineBuildConfig } from 'unbuild'

// build.config.ts, after
import { defineBuildConfig } from '@nuxt/module-builder'
```

Entries take the same shapes in `builder({ entries })`, `build.config.ts`, and the `build.entries` field of `package.json`, which the build also reads when there's no `tsdown.config.ts`. A string or `{ input, name }` object is a bundled entry. An object with an input that ends in `/` (or with `builder: 'mkdist'`) is a directory transpiled file by file:

```ts
builder({
  entries: [
    './src/utils',
    { input: 'src/features/', outDir: 'dist/features', ext: 'js' },
  ],
})
```

A directory entry's `outDir` must be inside `dist`. Its `ext` is `mjs` (the default) or `js`, and the declarations next to the scripts use the matching `.d.mts` or `.d.ts`. An `unbuild` field in `package.json` is read the same way as `build` but is deprecated: rename it to `build`, or move its options to `tsdown.config.ts`.

Any other option fails the build with the list of [unsupported build options](#unsupported-build-options).

## tsdown config

`builder()` is a tsdown plugin that builds a Nuxt module. Add it to a `tsdown.config.ts` in the module root:

```ts
// tsdown.config.ts
import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [builder()],
})
```

Build with `tsdown` itself, for example from the `prepack` script:

```json
{
  "scripts": {
    "prepack": "tsdown"
  }
}
```

`nuxt-module-build build` stays the zero-config way to build: it builds with this config when there is one, and produces the same `dist`, with the same checks and warnings. `nuxt-module-build prepare` reads the options of `builder()` from the config as well, and fails when the config sets `cwd` to another directory. `tsdown --watch` rebuilds `dist` when a source file changes, see [Developing against dist](#developing-against-dist).

`builder()` takes these options:

- `entries`: entries built besides `src/module`, in the shapes described in [Build configuration](#build-configuration).
- `externals`: package names and regular expressions that are never bundled. A package name also matches its subpaths.
- `replace`: compile-time replacements in bundled entries, as `{ search: replacement }` or as `{ values, delimiters, preventAssignment, objectGuards }`.

```ts
export default defineConfig({
  plugins: [
    builder({
      entries: ['./src/utils', { input: 'src/shared/', outDir: 'dist/shared' }],
      externals: ['#build/ui'],
      replace: { __VERSION__: JSON.stringify('1.0.0') },
    }),
  ],
})
```

Other tsdown options apply as usual, such as `outDir` (inside the module, see [Output directory](#output-directory)), `sourcemap`, `define`, `plugins`, and `hooks`. `deps.neverBundle` adds to the imports that are never bundled. `--outDir` and `--sourcemap` on the command line take precedence over the config.

Plugins in the config run alongside those of `builder()`, and its `hooks` as described in [Hooks in a tsdown config](#hooks-in-a-tsdown-config).

To build other entries alongside the module, export an array of configs. Give each config its own `outDir`, because the module's output directory is emptied before the build:

```ts
export default defineConfig([
  { plugins: [builder()] },
  { entry: { cli: 'src/cli.ts' }, outDir: 'dist-cli' },
])
```

Call `builder()` once, in the config that builds the module. One plugin shared by two configs fails the build.

### Hooks in a tsdown config

`builder()` has no hooks of its own. Use tsdown's `hooks` in the config, which receive tsdown's context (`ctx.options.cwd` is the module root and `ctx.options.outDir` the output directory), or a plugin:

- `build:prepare` runs before `builder()` checks the module's imports and empties the output directory, so it can generate sources. Files written into the output directory there are removed. Without `.nuxt`, `builder()` runs `nuxt-module-build prepare` before `build:prepare`, and that loads `src/module`, so generate the sources `src/module` imports before running tsdown, as described below.
- `build:done` runs once the build is complete, after `module.json` and `types.d.mts` are written and the paths in `package.json` are checked.
- To add a file to the output, emit it from a plugin. It is written before the paths in `package.json` are checked:

```ts
export default defineConfig({
  hooks: {
    'build:prepare': ctx => generateTypes(ctx.options.cwd),
  },
  plugins: [
    builder(),
    {
      name: 'config-cjs',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'config.cjs', source: 'module.exports = {}\n' })
      },
    },
  ],
})
```

Point `package.json` at the files the build emits, such as `./dist/module.mjs`, rather than renaming them afterwards.

tsdown hooks and plugins don't run for `nuxt-module-build prepare`, or for a playground that loads the module from its sources. Commit generated sources, or generate them in the module's own `dev:prepare` script before `nuxt-module-build prepare`.

`builder()` fails when it's given `hooks`.

### Options builder() sets

`builder()` sets these tsdown options, so the build fails when the config sets them too:

- `entry`: list entries in `builder({ entries })` instead.
- `format`, other than `esm`.
- `dts`, other than `true`. Declarations are generated with the module's own tsconfig, see [Declaration errors](#declaration-errors).
- `clean`: the output directory is emptied before a one-off build, and a watched build removes the files it no longer emits.
- `unbundle`, `exports`, `fixedExtension: false`, `outExtensions`, `platform` other than `node`, and `workspace`.
- `external` and `noExternal`: use `builder({ externals })`, `deps.neverBundle`, or `deps.alwaysBundle` instead.
- `deps.neverBundle` set to `true` or a function: list the imports instead.

The build also fails when another plugin changes one of these options, or when `outputOptions.entryFileNames` changes the file names of the bundled entries.

### Moving from build.config.ts

`build.config.ts` and the `build` and `unbuild` fields of `package.json` are read only when the module has no tsdown config. When it has one, any of them fails the build. Move their options into `tsdown.config.ts`, then delete the file or remove the field:

| `build.config.ts` | `tsdown.config.ts` |
| --- | --- |
| `entries` | `builder({ entries })` |
| `externals` | `builder({ externals })` |
| `replace` and `rollup.replace` | `builder({ replace })` |
| `sourcemap` | `sourcemap` |
| `hooks['build:before']` | tsdown's `hooks['build:prepare']`, see [Hooks in a tsdown config](#hooks-in-a-tsdown-config) |
| `hooks['rollup:done']` | a plugin that emits the extra files, or `package.json` paths that point at the emitted files |
| `hooks['build:done']` | tsdown's `hooks['build:done']` |
| `hooks['mkdist:*']` | drop them |
| `declaration`, `failOnWarn`, `name`, and `parallel` | drop them; `build.config.ts` ignored them, but `builder()` rejects them |

Your editor marks `defineBuildConfig` as deprecated.

When `build.config.ts` and a `build` or `unbuild` field both hold options, move them all into `builder()`: both lists of `entries`, the `externals` of both (each one once), and the replacements of both. `addRelativeDeclarationExtensions` on a directory entry can be dropped, as relative imports in declarations always get their extension. `src/module` is always built, so listing it in `entries` is harmless but unnecessary.

```ts
// build.config.ts, before
import { defineBuildConfig } from '@nuxt/module-builder'

export default defineBuildConfig({
  entries: ['./src/utils'],
  externals: ['#build/ui'],
  hooks: {
    'build:before': ctx => generateTypes(ctx.options.rootDir),
  },
})
```

```ts
// tsdown.config.ts, after
import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  hooks: {
    'build:prepare': ctx => generateTypes(ctx.options.cwd),
  },
  plugins: [
    builder({
      entries: ['./src/utils'],
      externals: ['#build/ui'],
    }),
  ],
})
```

Then build with `tsdown` instead of `nuxt-module-build build` in the module's scripts, such as `"prepack": "tsdown"`, and set up `dev:prepare` as described in [Developing a module](#developing-a-module).

`nuxt-module-build prepare` loads `tsdown.config.ts` with Node, so relative imports in it carry their file extension, as in [module code](#module-code-loads-with-node).

## Unsupported build options

The build fails with a list of every option it can't apply and the file each one comes from. Remove each option as described in the following sections, then build again.

### Hooks

Only `build:before`, `rollup:done`, and `build:done` run. They receive a context with `options.name`, `options.rootDir`, `options.outDir`, `options.entries`, `options.declaration`, `options.stub` (always `false`), `options.sourcemap`, and `pkg`.

- `mkdist:*` hooks are ignored with a warning. Remove them. See [mkdist options](#mkdist-options) for what they used to configure.
- Every other hook (`rollup:options`, `build:prepare`, `rollup:dts:options`, and so on) fails the build. Remove it. For hooks that adjusted rollup options, see [Rollup options](#rollup-options).

```ts
// before
export default defineBuildConfig({
  hooks: {
    'rollup:options'(ctx, options) {
      options.treeshake = false
    },
  },
})

// after: no hooks
export default defineBuildConfig({})
```

### Rollup options

The module entry is bundled with tsdown's defaults for a Node library. `rollup.*` options and the `rollup:options` hook have no equivalent and fail the build. Remove them. These exceptions are accepted: `rollup.replace` is applied; `rollup.emitCJS: false` and `rollup.cjsBridge: false` describe the default output; and `rollup.output.exports` only affects CommonJS output, which isn't emitted.

```ts
// before
export default defineBuildConfig({
  rollup: {
    inlineDependencies: true,
    esbuild: { target: 'es2020' },
  },
})

// after
export default defineBuildConfig({})
```

### CommonJS output

The build emits ES modules only, so `rollup.emitCJS: true` fails the build. Remove it, remove the `.cjs` files from `package.json`, and point `main` at `module.mjs`:

```json
{
  "exports": {
    ".": {
      "types": "./dist/types.d.mts",
      "import": "./dist/module.mjs"
    }
  },
  "main": "./dist/module.mjs"
}
```

The `.d.ts` declarations of bundled entries aren't generated either, so `typesVersions` entries that pointed at them need updating. See [typesVersions paths](#typesversions-paths).

### mkdist options

Runtime files are transpiled with oxc, one file at a time. Options that configured mkdist have no equivalent and fail the build: `esbuild`, `pattern`, `declaration` on an entry, and `format`. Remove them. Postcss plugins passed through `mkdist:entry:options` are ignored with a warning. Replace that processing as described in [Runtime stylesheets](#runtime-stylesheets). On a directory entry, `ext` (`mjs` or `js`) is applied, and `addRelativeDeclarationExtensions` is accepted and ignored: relative imports in declarations always get their extension.

```ts
// before
export default defineBuildConfig({
  entries: [
    { input: 'src/runtime/', outDir: 'dist/runtime', esbuild: { target: 'esnext' } },
  ],
})

// after
export default defineBuildConfig({})
```

### Other options

These options also fail the build:

- `stub` and `stubOptions`: remove them, and see [Stub builds](#stub-builds).
- `clean: false`: the output directory is emptied before a one-off build.
- `rootDir` or `outDir` set to anything other than the module root and `dist`.
- An array of more than one config: keep a single config object.
- A config that exports a function.
- Any key that unbuild didn't define.

## package.json paths

After every build, `package.json` is checked for paths the build didn't produce. The following sections cover each kind of path.

### Declaration paths

The module entry's declarations are `dist/types.d.mts` and `dist/module.d.mts`. Replace `.d.ts` with `.d.mts` in `exports`, `types`, and `typesVersions`:

```json
{
  "exports": {
    ".": {
      "types": "./dist/types.d.mts",
      "import": "./dist/module.mjs"
    }
  },
  "types": "./dist/types.d.mts"
}
```

### module.cjs

`dist/module.cjs` isn't generated. Replace it with `./dist/module.mjs` in `main`, `exports`, and anywhere else it appears. See [CommonJS output](#commonjs-output) for the `exports` shape.

### The types field

With `"moduleResolution": "bundler"`, which Nuxt projects use, TypeScript reads `exports` and ignores the top-level `types` field. With `node10` resolution, TypeScript ignores `exports` and resolves the root import through `types`, then `main`. A `typesVersions` entry doesn't change that root lookup. If your module supports `node10` consumers, set `types` to `./dist/types.d.mts` and add `typesVersions` for subpath exports. Otherwise, remove the field.

### typesVersions paths

TypeScript resolves `typesVersions` entries with `node10` rules. A path without an extension is probed as `.ts`, `.tsx`, `.d.ts`, and `/index.d.ts`, never as `.d.mts`. The build produces `.d.mts` for every bundled entry, so an entry without an extension stops resolving. The build warns with the file to use. Write each path with its extension:

```json
{
  "typesVersions": {
    "*": {
      "util": ["./dist/util.d.mts"]
    }
  }
}
```

`publint` doesn't report this. `attw` does, as a resolution failure in its `node10` column.

### Paths the build does not produce

Any other path in `exports`, `main`, `module`, `types`, or `typesVersions` that doesn't exist after the build is listed in a warning. Either add the entry that produces it (see [Build configuration](#build-configuration)), or remove the path.

## Stub builds

`nuxt-module-build build --stub` and `nuxt-module-build prepare --stub` have been removed, and fail with a link to this section. Replace the scripts that use them as described in [Developing a module](#developing-a-module):

- With pnpm or Yarn 4, point `package.json` at the module's sources as in [Source exports](#source-exports), and set `"dev:prepare": "nuxt-module-build prepare && nuxt prepare playground"`.
- With npm, Yarn 3 or earlier, or bun, keep `package.json` pointing at `dist`, set `"dev:prepare": "nuxt-module-build prepare && tsdown && nuxt prepare playground"`, and run `tsdown --watch` next to `nuxt dev playground`, as in [Developing against dist](#developing-against-dist).

Both scripts start with `nuxt-module-build prepare`, also where the old one had no `prepare` step, such as `nuxt-module-build build --stub . && nuxi prepare playground`. It writes the `.nuxt` that the build reads and, with source exports, the `.nuxt/module-builder/types.d.mts` that `package.json` points at.

`nuxt-module-build prepare`, and a playground that loads the module from its sources, run `src/module.ts` with Node, so module code follows the rules in [Module code loads with Node](#module-code-loads-with-node).

## Module code loads with Node

The module's build-time code has to load with Node as it is, because Nuxt 5 loads modules with Node itself. That covers `src/module.ts`, every file it imports by value (runtime files included), `build.config.ts`, and `tsdown.config.ts`. Node strips types and resolves imports as written, so `nuxt-module-build build`, `tsdown`, and `nuxt-module-build prepare` stop with a list of everything it can't load, each with its file, line, column, and fix. A runtime file in the list also names the module code that imports it. Node never loads type-only imports, so they don't stop the module loading, but a type check under `nodenext` module resolution, such as the playground's check of its `nuxt.config.ts`, still requires their extensions: write them with extensions too. Runtime files that module code doesn't import keep extensionless imports, as they're emitted with the extension added.

Set `erasableSyntaxOnly` so your editor and type check report the syntax as well:

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true
  }
}
```

Relative imports carry the imported file's extension: `./utils.ts`, not `./utils`, `./utils.js`, or `./dir`. The generated `.nuxt/tsconfig.json` sets `allowImportingTsExtensions`, so the `.ts` form type checks:

```ts
// before
import { helper } from './utils'
import { kit } from './kit'

// after
import { helper } from './utils.ts'
import { kit } from './kit/index.ts'
```

TypeScript syntax that stripping types doesn't remove is rewritten:

```ts
// before
export enum Mode { Light, Dark }
const size = <number>options.size
class Context {
  constructor(public name: string) {}
}

// after
export const Mode = { Light: 0, Dark: 1 } as const
export type Mode = typeof Mode[keyof typeof Mode]
const size = options.size as number
class Context {
  name: string
  constructor(name: string) {
    this.name = name
  }
}
```

A `namespace` with values becomes plain exports or an object, `import x = require('y')` becomes `import`, `export =` becomes `export default`, and a decorator becomes a function call.

A tsconfig `paths` alias becomes a relative import, or an entry in the `imports` of `package.json`, which Node resolves itself and tsdown bundles:

```ts
// before
import { logger } from '~/src/logger'

// after
import { logger } from './logger.ts'
// or, with "imports": { "#internal/*": "./src/internal/*.ts" } in package.json
import { logger } from '#internal/logger'
```

Node has no loader for single-file components or JSX, and only imports JSON with an import attribute. Move a value the module needs from a `.vue` or `.tsx` file into a plain `.ts` file (or use `import type`), and import JSON's default export with the attribute. Read properties from it rather than destructuring it, as `module.mjs` then contains only the properties that are read:

```ts
// before
import { name, version } from '../package.json'
import { sizes } from './runtime/components/Button.vue'

// after
import pkg from '../package.json' with { type: 'json' }
import { sizes } from './runtime/utils/sizes.ts'

console.log(pkg.name, pkg.version)
```

`#app`, `#imports`, and `#build/*` only exist inside a Nuxt app. Import types from them, and move code that needs their values into a runtime file the module adds, such as a plugin:

```ts
// before, in src/module.ts
import { useNuxtApp } from '#app'

// after
import type { NuxtApp } from '#app'
addPlugin(resolver.resolve('./runtime/plugin'))
```

Fix the list before you run `prepare` or `dev:prepare`: until it's empty, `prepare` stops and `.nuxt` isn't generated, so the module's type check and editor types have nothing to extend.

## Declaration errors

Declarations for the module entry and for `src/runtime` are generated with TypeScript, using your module's own `tsconfig.json`. Run `nuxt-module-build prepare` first, as described in [Preparing .nuxt](#preparing-nuxt). Errors that would leave the declarations missing or wrong fail the build. Every other type error, in `.ts` and `.vue` files alike, is reported as a warning.

### Portability errors

An export whose inferred type refers to a package your module can't import by name fails the build. Such a package is a dependency of a dependency, or another version of a package your module depends on. The error is TS2742, TS2883, TS4023, or another declaration emit error, in a `.ts` or a `.vue` file. It lists each export with its file and line. Give each one an explicit type annotation.

When the value comes from a function your module imports, annotate with that function's return type. The annotation then follows whichever version of the package the function comes from:

```ts
// before
export const handler = defineCachedHandler(...)

// after
export const handler: ReturnType<typeof defineCachedHandler> = defineCachedHandler(...)
```

Otherwise, import a type from a package your module depends on directly:

```ts
import type { EventHandler } from 'h3'

export const handler: EventHandler = defineEventHandler(...)
```

Syntax errors, and files for which no declaration could be emitted, fail the build as well.

### Other type errors

Type errors that don't change the declarations, such as a wrong argument type or a missing property, don't fail the build. This applies to `.ts` and `.vue` files alike. One warning per directory gives their number and the first three. Run your module's own type check, for example:

```bash
nuxt typecheck
# or
vue-tsc --noEmit
```

If the type check reports the same errors, fix them there. If it passes, the warning is safe to ignore.

Its errors come from build-time aliases (`#build/*`, `#internal/*`, and other paths into `.nuxt/`), which are typed as `any` while declarations are generated. The types in your module's `.nuxt` also reflect the module's default options. Code that only type-checks under a playground's configuration (a provider the playground enables, for example) warns here as well. An explicit annotation on the export removes that warning.

Those aliases are `any` in the emitted declarations too. An export whose type is inferred through one of them is declared as `any`, or as `string | number | symbol` for a key type. This includes a module's own generated alias, such as `#mdc-highlighter`. Annotate such an export with a type that refers to it by name, such as a component's props type or a type imported from the alias. The type then resolves against the consuming app's `.nuxt`:

```ts
import type { ComputedRef } from 'vue'
import { computed } from 'vue'
import theme from '#build/ui/button'
import type { ButtonProps } from '../components/Button.vue'

// before: inferred through `theme`, declared as `ComputedRef<any>`
export function useButtonSize(props: ButtonProps) {
  return computed(() => props.size ?? theme.defaultVariants.size)
}

// after: `ButtonProps['size']` is kept by name and resolves against the consuming app's `.nuxt`
export function useButtonSize(props: ButtonProps): ComputedRef<ButtonProps['size']> {
  return computed(() => props.size ?? theme.defaultVariants.size)
}
```

Routes your module registers with `addServerHandler` are typed from the module's own `.nuxt` (see [Module tsconfig](#module-tsconfig)). A composable that returns a `useFetch` or `$fetch` result for one of them is declared with the handler's response type. The response of any other route, one the playground or the consuming app defines, is typed `unknown`. To publish a precise type, type those calls or annotate the export:

```ts
import type { AsyncData, NuxtError } from 'nuxt/app'

export const useItems = () => useFetch<Item[]>('/api/items')

export const useItemsAnnotated = (): AsyncData<Item[] | undefined, NuxtError | undefined> => useFetch('/api/items')

export const fetchItems = () => $fetch<Item[]>('/api/items')
```

### Isolated declarations

With `isolatedDeclarations: true` in `tsconfig.json`, the module entry's declarations come from oxc. This is faster than TypeScript but requires an explicit type on every export. Write the module entry as follows:

```ts
import type { NuxtModule } from '@nuxt/schema'

const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({ /* ... */ })

export default module
```

Without `isolatedDeclarations`, the build is slower and prints a reminder once per run outside CI. Both settings work.

## Type checking build.config.ts

`unbuild` is no longer in your module's `node_modules`, so a `build.config.ts` that still imports from it fails the module's own type check with TS2307. Either change the import as shown in [Build configuration](#build-configuration), or exclude the file in `tsconfig.json`:

```json
{
  "exclude": ["build.config.ts"]
}
```

## Runtime stylesheets

Stylesheets under `src/runtime` are processed with lightningcss instead of postcss:

- `.css` files are emitted one to one. Nesting is flattened, vendor prefixes are added for the project's browserslist targets, and the output is minified. `@import` statements are kept as written.
- `.scss` and `.sass` files are compiled with your module's own `sass` or `sass-embedded`, written as `.css`, and not minified. Partials (`_name.scss`) aren't emitted. Install one of the two compilers when the runtime contains Sass:

  ```bash
  pnpm add -D sass
  ```

- An import of a compiled Sass file in a runtime script points at the emitted file: `import './x.scss'` becomes `import './x.css'`. Other stylesheet imports are kept as written.
- Postcss plugins and other postcss configuration aren't applied. Move that processing into the Nuxt app, or pre-process the stylesheets before the build.

## Runtime output

Each file under `src/runtime` is still emitted under `dist/runtime` with its name intact: scripts as `.js` with a `.d.ts`, and `.vue` files as `.vue` with a `.vue.d.ts`. Check these differences when a runtime file doesn't behave as before:

- Relative imports get the emitted extension (`../utils/merge` becomes `../utils/merge.js`). Non-relative specifiers (`#imports`, `#build/*`, and dependencies) are kept as written.
- Imports used only as types are removed from the JavaScript output.
- `.tsx` and `.jsx` files are emitted as `.jsx` with a `.d.ts`, with types stripped and the JSX kept, so the app compiles them with its own Vue JSX plugin. Pass paths to them without an extension, as in `resolver.resolve('./runtime/components/Foo')`.
- JSX that runs in Nitro or Node is still compiled to `vue/jsx-runtime` calls, as neither transforms files in `node_modules`. This covers files under a `server/` directory, and runtime files that these or other bundled entries import values from through relative paths. An import through an alias or the module's own package name isn't followed.
- A relative import of a file outside `src/runtime` is emitted where the import points (`src/shared/x.ts` becomes `dist/shared/x.js`). When that would leave `dist` or collide with another output, it's emitted under `dist/_external/` instead. A file that is only imported as a type gets a `.d.ts` and no script.
- Your module's own package name is never bundled into `module.mjs`. Its `#` subpath imports from the `imports` of `package.json` are bundled.

## Output directory

A one-off build empties `--outDir` (`dist` by default) before writing to it, and `tsdown --watch` removes the files in it that the build no longer emits, so the directory must be inside your module. An `--outDir` of `.`, or of a directory that contains the module, fails the build.

## Module tsconfig

Declarations are generated with your module's own `.nuxt`, which `nuxt-module-build prepare` writes from a Nuxt instance that runs the module alone. Extend it from the module's `tsconfig.json`, and leave the playground to its own `tsconfig.json`:

```json
{
  "extends": "./.nuxt/tsconfig.json",
  "exclude": ["dist", "node_modules", "playground"]
}
```

The tsconfig that covers your module might extend or reference a playground's `.nuxt/tsconfig.json` instead. This can be the module's own tsconfig or a monorepo root's, such as `../../tsconfig.json`. In that case, the build generates declarations with `./.nuxt/tsconfig.json` plus that tsconfig's own `compilerOptions`, and prints a note saying so. `types` and `paths` are included, apart from paths into the playground's `.nuxt`.

In a monorepo, give the module a `tsconfig.json` of its own as shown above. Move any `compilerOptions.types` the module relies on into it, such as `"types": ["youtube"]` for a global namespace. They then apply to the module's own type check as well as to the build.

The declaration program starts from your module's own files only. Files the tsconfig includes outside the module root (a workspace, with `typescript.includeWorkspace`) are left out. So are files under the module's `playground*`, `docs`, `test`, `tests`, `fixtures`, `example`, and `examples` directories. Their routes and type augmentations therefore don't end up in `dist`. Files that your module's sources import are still followed, wherever they are.

## Preparing .nuxt

Declarations are generated against `.nuxt/tsconfig.json`, so a build runs `nuxt-module-build prepare` first when `.nuxt` is missing. `prepare` loads `src/module.ts` with Node, so the rules in [Module code loads with Node](#module-code-loads-with-node) are checked there too. Keep `prepare` first in your module's `dev:prepare` script, as in [Developing a module](#developing-a-module), so the build doesn't have to:

```json
{
  "scripts": {
    "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground",
    "prepack": "tsdown"
  }
}
```

## Developing a module

The playground installs the module by its package name, so it loads whatever `package.json` points at. Which setup to use depends on the package manager that publishes the module:

- With pnpm or Yarn 4, `package.json` points at the module's sources, and `publishConfig` holds the `dist` paths that are published. See [Source exports](#source-exports).
- With npm, Yarn 3 or earlier, or bun, `package.json` points at `dist`, and `tsdown --watch` rebuilds it while you develop. See [Developing against dist](#developing-against-dist).

Run `dev:prepare` after you install dependencies, and again when the module registers something new for types, such as a template or a server route.

### Source exports

pnpm and Yarn 4 publish the fields of `publishConfig` in place of the top-level ones. With either of them, point `exports`, `imports`, `main`, and `types` at `src`, and the same fields in `publishConfig` at `dist`. The playground then loads the module from its sources, with no build. Packing replaces each field as a whole, so `publishConfig.exports` and `publishConfig.imports` repeat every subpath and condition:

```json
{
  "exports": {
    ".": { "types": "./.nuxt/module-builder/types.d.mts", "style": "./src/runtime/index.css", "default": "./src/module.ts" },
    "./utils": { "types": "./src/utils.ts", "default": "./src/utils.ts" }
  },
  "imports": {
    "#shared/*": "./src/runtime/shared/*.ts"
  },
  "main": "./src/module.ts",
  "types": "./.nuxt/module-builder/types.d.mts",
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/types.d.mts", "style": "./dist/runtime/index.css", "default": "./dist/module.mjs" },
      "./utils": { "types": "./dist/utils.d.mts", "default": "./dist/utils.mjs" }
    },
    "imports": {
      "#shared/*": "./dist/runtime/shared/*.js"
    },
    "main": "./dist/module.mjs",
    "types": "./dist/types.d.mts"
  },
  "scripts": {
    "dev": "nuxt dev playground",
    "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground",
    "prepack": "tsdown"
  }
}
```

`nuxt-module-build prepare` writes `.nuxt/module-builder/types.d.mts`. It re-exports `src/module.ts` and declares the same `#app` and `@nuxt/schema` augmentations as `dist/types.d.mts`, for the module's `ModuleHooks`, `ModuleRuntimeHooks`, `ModuleRuntimeConfig`, and `ModulePublicRuntimeConfig`. The root export's `types` condition and the top-level `types` point at it, so the playground's type check sees the module's hooks and runtime config. A subpath export has no augmentations, so it points at its source.

The playground's type check includes the module's sources and the files they import types from. A built `dist` keeps them out, because declarations aren't checked. The errors this can report, and their fixes:

- `#app`, `#imports`, or `#build/*` not found (TS2307, TS2664) in the `nuxt.config.ts` context, through types that module code imports from a runtime file that uses them: move those types into a file that doesn't import the aliases, such as `src/runtime/types.ts`.
- Relative imports without extensions (TS2835, TS2834) in the `nuxt.config.ts` context, which resolves them like Node: add extensions to type-only relative imports as well.
- Globals that the module declares in its own `.d.ts` not found (TS2304), because the playground doesn't include that file: reference it with `/// <reference path="..." />` from the files that use the globals.
- The module's own aliases not found (TS2307): move an alias from the module's tsconfig `paths` into the `imports` of `package.json`, with its `dist` paths in `publishConfig.imports`, as TypeScript resolves those from the module's files in any project. Declare the types of an alias that the module adds itself, such as a virtual module, with `addTypeTemplate(template, { nuxt: true, node: true })`, so both of the playground's contexts include them.
- Other errors in runtime files, which are checked with the playground's compiler options: fix them, or check the module with the same options.

With source exports there is no `dist` while you develop, so code that reaches into `dist` by path has to point at `src`: a playground or a test that imports `../dist/runtime/...`, or module code that resolves `../dist/runtime/...`. Resolve runtime files relative to `src/module.ts` and without an extension, as `createResolver(import.meta.url).resolve('./runtime/plugins/plugin')` does: the build keeps the layout of `src` in `dist`, and Nuxt and Vite add the extension.

A subpath that code outside Nuxt imports, such as a plugin for a plain Vite app, can keep pointing at `dist` in `exports`, so that code loads the built file. Run `tsdown` before using it.

Yarn 4 doesn't apply `publishConfig.typesVersions`. Keep `typesVersions` at the top level, pointing at `dist`: TypeScript only reads it under `node10` module resolution, which a playground doesn't use.

A playground that lists the module by relative path, such as `modules: ['../src/module']`, keeps working unchanged: it loads `src/module.ts` and never resolves the package. It doesn't load `types.d.mts` either, so its type check doesn't see the augmentations for `ModuleHooks`, `ModuleRuntimeHooks`, `ModuleRuntimeConfig`, and `ModulePublicRuntimeConfig`. The module's name only has to resolve where something imports the module or one of its subpaths by name: the playground's `nuxt.config.ts` or code, tests, or the module's own runtime files. Then the playground has to resolve the name to the module directory itself, as `"my-module": "workspace:*"` or `"my-module": "link:.."` do. Vite serves the files under `src/runtime` from there, so components update in place and plugins reload the page. The playground loads `src/module.ts` once, when `nuxt dev` starts: restart `nuxt dev` after changing module code.

The build checks the published paths, as described in [Publishing source exports](#publishing-source-exports). tsdown's `publint` and `attw` options lint the packed tarball, so both see `dist`.

### Publishing source exports

Every build reads the path fields of `package.json` with `publishConfig` applied, and fails when one of them points at a path that doesn't work once the package is installed:

- a TypeScript source other than a declaration, which Node doesn't load from `node_modules`
- a path that the pack leaves out because `files` doesn't list it, or, without `files`, a path into `.nuxt`

Every pack includes `package.json` and the file that `main` points at, so `files` doesn't have to list them. An `imports` entry is only checked when the build output still imports it, so an entry that the build bundles, or rewrites to a relative path, can keep pointing at `src`. To publish a file other than a TypeScript source as it is, list it in `files`:

```json
{
  "files": ["dist", ".nuxt/ui.static.css"],
  "imports": {
    "#build/ui.css": "./.nuxt/ui.static.css"
  }
}
```

When `tsdown` or `nuxt-module-build build` runs as the `prepack` or `prepublishOnly` script, the build also fails when the package manager that packs would publish such a path as written:

- The package manager that packs has to be pnpm or Yarn 4. npm, Yarn 1, and bun pack `package.json` as written. Yarn 4 packs `typesVersions` as written too. Yarn 2 only replaces `main` and `module`, and Yarn 3 also `exports` and `imports`.
- `publishConfig` has to set each of those fields, to paths that pass the check above.

The check reads `npm_lifecycle_event`, so it only runs when the build is the `prepack` or `prepublishOnly` script itself. A `prepack` script that runs another script, such as `"prepack": "npm run build"`, isn't checked: the nested script runs as `build`. Run `tsdown` or `nuxt-module-build build` from `prepack` directly.

The package manager is read from the `npm_config_user_agent` and `npm_execpath` environment variables. Publish with `pnpm publish` or `yarn npm publish`. A `release` script that runs `npm publish` fails, even when `pnpm run` starts it. `npm publish` of a tarball that `pnpm pack` wrote works, as its `package.json` already has the `dist` paths and the build doesn't run again. `bun pm pack` and `bun publish` started from a pnpm or Yarn 4 script pass on that script's variables, so the build can't tell them apart from pnpm or Yarn.

### Developing against dist

npm, Yarn 3 and earlier, and bun publish some or all of these fields as written. With them, point `package.json` at `dist`, and build it before the playground is prepared:

```json
{
  "exports": {
    ".": { "types": "./dist/types.d.mts", "default": "./dist/module.mjs" },
    "./utils": { "types": "./dist/utils.d.mts", "default": "./dist/utils.mjs" }
  },
  "main": "./dist/module.mjs",
  "types": "./dist/types.d.mts",
  "scripts": {
    "dev": "nuxt dev playground",
    "dev:prepare": "nuxt-module-build prepare && tsdown && nuxt prepare playground",
    "prepack": "tsdown"
  }
}
```

A playground that installs the module by name lists it as `"my-module": "workspace:*"` or `"my-module": "link:.."`. Yarn 1 has no `workspace:` protocol, so use `link:..` there.

While `nuxt dev playground` runs, run `tsdown --watch` next to it. `tsdown --watch` leaves `dist` in place while its first build runs, so the two can start together. Each change under `src` rebuilds `dist`, in about a second for a small module, or less with [isolated declarations](#isolated-declarations). A rebuild only writes the files whose content changed, so the playground updates an edited component in place, and reloads the page for an edited plugin. The playground loads `dist/module.mjs` once, when `nuxt dev` starts: restart `nuxt dev` after changing module code.

## Output size

Every tsdown build reports the size of its output. A module with runtime directories gets a summary, followed by one line for each bundled entry and runtime directory, with the size of its code and of its declarations; others get a line for each file. On a rebuild under `tsdown --watch`, the summary and the per-file lines only count the files that were written, while the lines for each entry and runtime directory cover the whole build. Set `report` in `tsdown.config.ts` to change it: `{ summary: true }` or `{ summary: false }`, `{ gzip: false }` to skip compressing each file, `{ brotli: true }`, or `false` to turn it off. `module.json` and `types.d.mts` are written after the report, so they aren't in it.

To check the published size in CI, `npm pack --dry-run --json` lists exactly what gets published: each file's `size`, plus the gzipped tarball's `size` and the `unpackedSize`:

```bash
npm pack --dry-run --json | jq '.[0] | { size, unpackedSize, files: [.files[] | { path, size }] }'
```

## Removed dependencies

`unbuild`, `mkdist`, `jiti`, `defu`, and `magic-regexp` are no longer installed with `@nuxt/module-builder`. If your module imports any of them in its own code, add it to the module's own dependencies.

Remove `unbuild` from your module's `devDependencies`. Remove `mkdist` and `jiti` too, when they only served the builder:

```bash
pnpm remove unbuild
```

## Checklist

Follow these steps in order to upgrade a module. Each step is mechanical until the build runs. Use your module's own package manager where `pnpm` is written.

1. Use Node 22.18+, 24.11+, or 26+ locally and in CI.
2. Run `pnpm add -D @nuxt/module-builder@^2.0.0 tsdown@^0.23.7`, then `pnpm remove unbuild` (and `mkdist` and `jiti`, if they only served the builder). Do this before step 3.
3. Move the options of `build.config.ts` and of the `build` or `unbuild` field of `package.json` into `builder()` in a `tsdown.config.ts`, as described in [Moving from build.config.ts](#moving-from-buildconfigts), including directory entries such as `{ input: 'src/x/', outDir: 'dist/x' }`. Then delete `build.config.ts` and remove the field. A module without options still gets a `tsdown.config.ts` with `plugins: [builder()]`, so that `tsdown` builds it.
4. In `package.json`, replace `.d.ts` with `.d.mts` for `types.d.ts` and `module.d.ts`, replace `module.cjs` with `module.mjs`, and remove `.cjs` entries. Set the top-level `types` field to `./dist/types.d.mts`, or remove it. Give every `typesVersions` path its full file name (`./dist/util.d.mts`, not `dist/util`).
5. Add `"erasableSyntaxOnly": true` to `tsconfig.json`, and rewrite any `enum`, `namespace`, parameter property, or `<T>value` assertion the type check reports.
6. Make module code load with Node, as described in [Module code loads with Node](#module-code-loads-with-node): add the `.ts` extension to relative imports in `src/module.ts` and the files it imports by value, runtime files included (`./utils` becomes `./utils.ts`, `./dir` becomes `./dir/index.ts`), replace value imports through tsconfig `paths` aliases, and move value imports of `#app`, `#imports`, and `#build/*` into runtime files. Do this before step 8: `prepare` lists each problem and doesn't generate `.nuxt` until they're fixed.
7. If the runtime contains `.scss` or `.sass` files, run `pnpm add -D sass`.
8. Set the `prepack` script to `tsdown`. With pnpm or Yarn 4, point `package.json` at the module's sources and the same fields in `publishConfig` at `dist`, and set `dev:prepare` to `nuxt-module-build prepare && nuxt prepare playground`, as in [Source exports](#source-exports). With npm, Yarn 3 or earlier, or bun, set `dev:prepare` to `nuxt-module-build prepare && tsdown && nuxt prepare playground`, as in [Developing against dist](#developing-against-dist). Run `nuxt-module-build prepare`, then `tsdown`. Fix what the build reports: remove each unsupported build option and annotate each export in a portability error. Build again until it passes.
9. Run your module's own type check (for example, `nuxt typecheck` or `vue-tsc --noEmit`) and fix what it reports. A build warning about type errors that the type check doesn't reproduce is safe to ignore. Annotate exports whose type is inferred through a `#build/*` alias; otherwise `dist` declares them as `any`.
10. Run `pnpm dlx publint`. Then run `pnpm pack` and `pnpm dlx @arethetypeswrong/cli <name>-<version>.tgz`, and fix any path they report. (`attw --pack .` only works with npm, and `npm pack` fails on packages with `devEngines`.)
11. Run your module's tests and the playground.
