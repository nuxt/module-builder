---
title: Upgrading to v2
description: Move a Nuxt module from v1 to v2 of `@nuxt/module-builder`, which builds with tsdown.
---

This guide takes a Nuxt module from v1 to v2 of the module builder. In v2, `@nuxt/module-builder` builds your module with [tsdown](https://tsdown.dev) instead of unbuild. The CLI, the project layout (`src/module.ts` and `src/runtime/`), and the output of your build stay the same.

Most modules upgrade by running the build and following its output. Every message that requires a change starts with a code, such as `NUXT_MB_D0001`, and links to the matching section of this guide. If you'd rather work through everything up front, use the [checklist](#checklist) at the end.

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

Then replace `nuxt-module-build build` with `tsdown` in the module's scripts, and set up `dev:prepare`, as described in [Scripts](#scripts).

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

Runtime files are transpiled with oxc, one file at a time. Options that configured mkdist have no equivalent and fail the build: `esbuild`, `pattern`, and `format`. Remove them. `declaration` on an entry is accepted and ignored, like the top-level option. Postcss plugins passed through `mkdist:entry:options` are ignored with a warning. Replace that processing as described in [Runtime stylesheets](#runtime-stylesheets). On a directory entry, `ext` (`mjs` or `js`) is applied, and `addRelativeDeclarationExtensions` is accepted and ignored: relative imports in declarations always get their extension.

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

With `"moduleResolution": "bundler"`, which Nuxt projects use, TypeScript reads `exports` and ignores the top-level `types` field. With `node10` resolution, TypeScript ignores `exports` and resolves the root import through `types`, then `main`. A `typesVersions` entry doesn't change that root lookup.

TypeScript resolves with `node10` in a project whose tsconfig sets `"moduleResolution": "node"` or `"node10"`, or sets `"module": "commonjs"` without a `moduleResolution`. Every tsconfig that Nuxt 4 generates for an app uses `bundler`, so an app on Nuxt 4 reads `exports` only. Your module supports `node10` consumers if other projects that type check with such a tsconfig import it, such as a library or a tool with an older setup:

- If it does, set `types` to `./dist/types.d.mts`, and add `typesVersions` for subpath exports, as described in [typesVersions paths](#typesversions-paths).
- Otherwise, remove `types` and `typesVersions`. The root import still resolves under `node10`, through `main`, but subpath exports don't. `attw` then reports a resolution failure (`NoResolution`) in its `node10` column for each subpath export, which `--profile esm-only` leaves out, as described in [Checking the package](#checking-the-package).

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

## Commands

The builder's command has three names: `nuxt-module-build`, its alias `nuxt-build-module`, and `nuxt build-module` (or `nuxi build-module`) through the Nuxt CLI. This guide writes `nuxt-module-build`, and everything it says about that command applies to the other names too.

Each of them needs a subcommand. Without one they print their usage, so a command such as `nuxt-module-build` in `prepack` becomes `tsdown`, or `nuxt-module-build build`.

## Scripts

In each script that runs the builder, change only the builder's commands, and keep every other command where it is. That covers `prepack` and `dev:prepare`, and any other script or CI workflow that runs `nuxt-module-build`, `nuxt-build-module` or `nuxt build-module`, such as `build`, `stub` or `release`. The rules below name `nuxt-module-build`, and apply to the other names in the same way:

- `nuxt-module-build build` becomes `tsdown`. `tsdown` takes no module directory: its arguments are entry files, so `nuxt-module-build build .` becomes `tsdown` too. For another directory, run `tsdown` there, as `cd packages/my-module && tsdown`, or keep `nuxt-module-build build packages/my-module`, which builds with that directory's tsdown config.
- `nuxt-module-build build --stub` is removed when `package.json` points at the module's sources, as in [Source exports](#source-exports). When it points at `dist`, as in [Developing against dist](#developing-against-dist), it becomes `tsdown`, after `nuxt-module-build prepare` and before the first `nuxt prepare`.
- `nuxt-module-build prepare --stub` becomes `nuxt-module-build prepare`.
- `nuxt-module-build prepare` runs before the build and before every `nuxt prepare` in `dev:prepare`. Add it where the script doesn't run it.
- A script that only ran the stub build, such as `"stub": "nuxt-module-build build --stub ."`, has nothing left to run. Delete it, and remove it from the scripts that run it, such as `"dev:prepare": "pnpm stub && nuxt prepare playground"`.

For example, these scripts also minify a script into `dist` and prepare a docs app:

```json
{
  "scripts": {
    "prepack": "nuxt-module-build build && esbuild --minify src/script.js --outfile=dist/script.min.js",
    "dev:prepare": "nuxt-module-build build --stub && nuxt-module-build prepare && nuxt prepare playground && nuxt prepare docs"
  }
}
```

With source exports, they become:

```json
{
  "scripts": {
    "prepack": "tsdown && esbuild --minify src/script.js --outfile=dist/script.min.js",
    "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground && nuxt prepare docs"
  }
}
```

With `package.json` pointing at `dist`, `dev:prepare` builds `dist` instead:

```json
{
  "scripts": {
    "prepack": "tsdown && esbuild --minify src/script.js --outfile=dist/script.min.js",
    "dev:prepare": "nuxt-module-build prepare && tsdown && nuxt prepare playground && nuxt prepare docs"
  }
}
```

The build empties `dist` before it writes to it, so a command that writes into `dist` runs after `tsdown`, as `esbuild` does here.

The checks in [Publishing source exports](#publishing-source-exports) that depend on the package manager run when `tsdown` is a command of the `prepack` or `prepublishOnly` script itself, as in the `prepack` above. A `prepack` that runs another script, such as `"prepack": "pnpm run build"`, isn't checked, as that script's commands run as `build`. To keep the checks, run the commands of `build` from `prepack` directly:

```json
{
  "scripts": {
    "build": "tsdown && pnpm build:client",
    "prepack": "tsdown && pnpm build:client"
  }
}
```

## Stub builds

`nuxt-module-build build --stub` and `nuxt-module-build prepare --stub` have been removed, and fail with a link to this section. Change the scripts that use them as described in [Scripts](#scripts):

- With pnpm or Yarn 4, point `package.json` at the module's sources as in [Source exports](#source-exports), and remove `nuxt-module-build build --stub` from `dev:prepare`.
- With npm, Yarn 3 or earlier, or bun, keep `package.json` pointing at `dist`, replace `nuxt-module-build build --stub` with `tsdown` after `nuxt-module-build prepare`, and run `tsdown --watch` next to `nuxt dev playground`, as in [Developing against dist](#developing-against-dist).

In both, `dev:prepare` runs `nuxt-module-build prepare`, also where the old script had no `prepare` step, such as `nuxt-module-build build --stub . && nuxt prepare playground`. It writes the `.nuxt` that the build reads and, with source exports, the `.nuxt/module-builder/types.d.mts` that `package.json` points at.

`nuxt-module-build prepare`, and a playground that loads the module from its sources, run `src/module.ts` with Node, so module code follows the rules in [Module code loads with Node](#module-code-loads-with-node).

## Module code loads with Node

The module's build-time code has to load with Node as it is, because Nuxt 5 loads modules with Node itself. That covers `src/module.ts`, every file it imports by value (runtime files included), `build.config.ts`, and `tsdown.config.ts`. Node strips types and resolves imports as written, so `nuxt-module-build build`, `tsdown`, and `nuxt-module-build prepare` stop with a list of everything it can't load, each with its file, line, column, and fix. A runtime file in the list also names the module code that imports it. Node never loads type-only imports, so they don't stop the module loading. A type check that resolves imports like Node still requires their extensions, such as the playground's check of its `nuxt.config.ts` context when the playground sets `future.compatibilityVersion: 5`: write them with extensions too. Runtime files that module code doesn't import keep extensionless imports, as they're emitted with the extension added.

Set `erasableSyntaxOnly` in the tsconfig for module code, `tsconfig.module.json` in [Module tsconfig](#module-tsconfig), so your editor and type check report the syntax as well:

```json
{
  "extends": "./.nuxt/tsconfig.node.json",
  "compilerOptions": {
    "erasableSyntaxOnly": true
  }
}
```

Relative imports carry the imported file's extension: `./utils.ts`, not `./utils`, `./utils.js`, or `./dir`. The generated tsconfigs set `allowImportingTsExtensions`, so the `.ts` form type checks:

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
// src/module.ts, before
import { useNuxtApp } from '#app'

// src/module.ts, after
import { addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  meta: { name: 'my-module', configKey: 'myModule' },
  setup() {
    const resolver = createResolver(import.meta.url)

    addPlugin(resolver.resolve('./runtime/plugin'))
  },
})
```

```ts
// src/runtime/plugin.ts
import { defineNuxtPlugin } from '#imports'

export default defineNuxtPlugin((nuxtApp) => {
  // code that needs the Nuxt app
})
```

Fix the list before you run `prepare` or `dev:prepare`. Until it's empty, `prepare` stops and doesn't generate `.nuxt`. The module's type check and editor types then have nothing to extend.

## Declaration errors

Declarations for the module entry and for `src/runtime` are generated with TypeScript, using the tsconfig project that includes each file, as described in [Module tsconfig](#module-tsconfig). Run `nuxt-module-build prepare` first, as described in [Preparing .nuxt](#preparing-nuxt). Errors that would leave the declarations missing or wrong fail the build. Every other type error, in `.ts` and `.vue` files alike, is reported as a warning.

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

Type errors that don't change the declarations, such as a wrong argument type or a missing property, don't fail the build. This applies to `.ts` and `.vue` files alike. One warning per directory gives their number and the first three, and names your module's own type check: `vue-tsc -b --noEmit` with the tsconfigs in [Module tsconfig](#module-tsconfig), or `vue-tsc --noEmit` with a `tsconfig.json` that extends `./.nuxt/tsconfig.json`. Run it:

```bash
vue-tsc -b --noEmit
```

If the type check reports the same errors, fix them there. If it passes, the warning is safe to ignore.

`nuxt typecheck` in the module root type checks it as an app, and regenerates `.nuxt` without the changes that `prepare` makes. Use `vue-tsc` for the module, and `nuxt typecheck playground` for the playground.

Its errors come from build-time aliases (`#build/*`, `#internal/*`, and other paths into `.nuxt/`), which are typed as `any` while declarations are generated. The types in your module's `.nuxt` also reflect the module's default options. Code that only type-checks under a playground's configuration (a provider the playground enables, for example) warns here as well. An explicit annotation on the export removes that warning.

Those aliases are `any` in the emitted declarations too. An export whose type is inferred through one of them is declared as `any`, or as `string | number | symbol` for a key type. This includes a module's own generated alias, such as `#mdc-highlighter`. Annotate such an export with a type that refers to it by name. That can be a component's props type, or a type imported from the alias. The type then resolves against the `.nuxt` of the app that installs the module:

```ts
import type { ComputedRef } from 'vue'
import { computed } from 'vue'
import theme from '#build/ui/button'
import type { ButtonProps } from '../components/Button.vue'

// before: inferred through `theme`, declared as `ComputedRef<any>`
export function useButtonSize(props: ButtonProps) {
  return computed(() => props.size ?? theme.defaultVariants.size)
}

// after: `ButtonProps['size']` is kept by name and resolves against the app's own `.nuxt`
export function useButtonSize(props: ButtonProps): ComputedRef<ButtonProps['size']> {
  return computed(() => props.size ?? theme.defaultVariants.size)
}
```

Routes your module registers with `addServerHandler` are typed from the module's own `.nuxt` (see [Module tsconfig](#module-tsconfig)). A composable that returns a `useFetch` or `$fetch` result for one of them is declared with the handler's response type. The response of any other route, one the playground or the app that installs the module defines, is typed `unknown`. To publish a precise type, type those calls or annotate the export:

```ts
import type { AsyncData, NuxtError } from 'nuxt/app'

export const useItems = () => useFetch<Item[]>('/api/items')

export const useItemsAnnotated = (): AsyncData<Item[] | undefined, NuxtError | undefined> => useFetch('/api/items')

export const fetchItems = () => $fetch<Item[]>('/api/items')
```

### Isolated declarations

With `isolatedDeclarations: true` in the tsconfig that includes `src/module.ts`, the module entry's declarations come from oxc. This is faster than TypeScript but requires an explicit type on every export. Write the module entry as follows:

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

Each file under `src/runtime` is still emitted under `dist/runtime` with its name intact. Scripts become `.js` with a `.d.ts`, and `.vue` files stay `.vue` with a `.vue.d.ts`. Check these differences when a runtime file doesn't behave as before:

- Relative imports get the emitted extension (`../utils/merge` becomes `../utils/merge.js`). Non-relative specifiers (`#imports`, `#build/*`, and dependencies) are kept as written.
- Imports used only as types are removed from the JavaScript output.
- `.tsx` and `.jsx` files are emitted as `.jsx` with a `.d.ts`, with types stripped and the JSX kept, so the app compiles them with its own Vue JSX plugin. Pass paths to them without an extension, as in `resolver.resolve('./runtime/app/components/Foo')`.
- JSX that runs in Nitro or Node is still compiled to `vue/jsx-runtime` calls, as neither transforms files in `node_modules`. This covers files under a `server/` directory, and runtime files that these or other bundled entries import values from through relative paths. An import through an alias or the module's own package name isn't followed.
- A relative import of a file outside `src/runtime` is emitted where the import points (`src/shared/x.ts` becomes `dist/shared/x.js`). When that would leave `dist` or collide with another output, it's emitted under `dist/_external/` instead. A file that is only imported as a type gets a `.d.ts` and no script.
- Your module's own package name is never bundled into `module.mjs`. Its `#` subpath imports from the `imports` of `package.json` are bundled.

## Output directory

A one-off build empties `--outDir` (`dist` by default) before it writes to it. `tsdown --watch` removes the files in it that the build doesn't emit any more. The directory must therefore be inside your module. An `--outDir` outside the module, such as `../dist`, or the module root itself, fails the build.

## Module tsconfig

`nuxt-module-build prepare` writes the module's own `.nuxt` from a Nuxt instance that runs the module alone. It has one tsconfig for each part of the module: `tsconfig.node.json` for `src/module.ts` and the files next to it, `tsconfig.app.json` for `src/runtime`, `tsconfig.server.json` for `src/runtime/server`, and `tsconfig.shared.json` for code that both the app and the server use. Reference them from the module's `tsconfig.json`, and leave the playground to its own `tsconfig.json`:

```json
{
  "files": [],
  "exclude": ["dist", "node_modules", "playground"],
  "references": [
    { "path": "./tsconfig.module.json" },
    { "path": "./.nuxt/tsconfig.app.json" },
    { "path": "./.nuxt/tsconfig.server.json" },
    { "path": "./.nuxt/tsconfig.shared.json" }
  ]
}
```

To change the options of one part, reference a tsconfig of your own that extends the generated one, in its place. Here `tsconfig.module.json` takes the place of `./.nuxt/tsconfig.node.json` for module code:

```json
{
  "extends": "./.nuxt/tsconfig.node.json",
  "compilerOptions": {
    "erasableSyntaxOnly": true,
    "tsBuildInfoFile": "./.nuxt/tsconfig.module.tsbuildinfo"
  }
}
```

`vue-tsc -b` writes a `.tsbuildinfo` file for each project, next to its tsconfig unless `tsBuildInfoFile` says otherwise. Those of the generated tsconfigs go in `.nuxt`, and `tsBuildInfoFile` puts this one there too.

Type check with `vue-tsc -b --noEmit`. It checks each part as its own program, so it takes longer than `vue-tsc --noEmit` with a single tsconfig: between about 1.1 and 2.4 times as long, for the modules it was measured on. The build generates each file's declarations with the project that includes it, trying the module's own tsconfigs before the generated ones and the app's last. tsdown reads the project that includes `src/module.ts`, unless the tsdown config sets `tsconfig`.

Auto-imports are off in the module's own `.nuxt`, so runtime code imports what it uses, such as `defineEventHandler` from `h3` or `useNuxtApp` from `#imports`.

### Generated tsconfigs

`prepare` adapts the generated tsconfigs to a module:

- The app's tsconfig covers `src/runtime` and the module's other runtime directories rather than the whole module root, less the root's `exclude`.
- The root's `compilerOptions`, with those of the tsconfigs it extends, are copied into all four, apart from path options such as `paths` and `rootDir`. Its `types` are added to those Nuxt sets. Put options that every part needs there, such as `"types": ["youtube"]` for a global namespace. Leave out `types` that only tests or other tools use, such as `"vitest/globals"`, as they would apply to every part too.
- All five, `.nuxt/tsconfig.json` included, set `allowImportingTsExtensions`, which Nuxt versions before 4.5 leave out, unless the root's `compilerOptions` set it.
- The module's `.d.ts` files are added as well, apart from those in the runtime directories, in the output directory (`dist` by default), in the root's `exclude`, and in the `playground*`, `docs`, `test`, `tests`, `fixtures`, `example` and `examples` directories. Those that only declare globals and ambient modules, with no top-level `import` or `export`, go to all four. Module augmentations, with a top-level `import` or `export` and a `declare module` or `declare global`, go to the app and to module code, the parts that Nuxt gives an installed module's types. Other `.d.ts` modules only apply to the files that import them.
- Module code gets the app's aliases, declarations (with the type templates that the app's tsconfig includes) and JSX options, for the runtime files it imports.
- Module code also gets `.nuxt/module-builder/types.d.mts`, so the augmentations for the `ModuleHooks`, `ModuleRuntimeHooks`, `ModuleRuntimeConfig` and `ModulePublicRuntimeConfig` that `src/module.ts` exports apply to it, as they do in an app that installs the module.
- In the app, server and shared tsconfigs, the module's own package name resolves to declarations of module code that `prepare` writes into `.nuxt/module-builder/declarations`, with a `types.d.mts` that has the same augmentations, and the subpath of each other bundled entry resolves to that entry's declarations. A type template or a runtime file that imports from the module's own name then gets the types an app that installs the module gets, without type checking module code in that part. `prepare` writes the declarations of the module code that those of the bundled entries refer to. A declaration error there, such as an export whose type can't be named, is a warning. Fix it as described in [Portability errors](#portability-errors).

The app's tsconfig also includes `test/nuxt` and `tests/nuxt`, as an app's does, unless the root's `exclude` leaves them out. Other files, such as the other tests and fixtures, are in none of them. Reference a tsconfig of your own to type check them.

### Type checking each part

Each part is type checked on its own, with the files it imports and the types that part has in an app. A `tsconfig.json` that extends `./.nuxt/tsconfig.json` checks the whole module root as one program with the app's types, so it doesn't report some of the errors below. Each entry gives the error, what it means and the fix:

- **Missing `types` in module code** (TS2304, TS2503, such as `Cannot find namespace 'YT'`). Runtime files that module code imports are type checked with module code too. The root's `types` apply to it, but a `types` list in `tsconfig.module.json` replaces them, so repeat them there, such as `"types": ["youtube", "google.maps"]`.
- **An augmentation that only another file brings in** (TS2322, TS2339, TS2353). Module code that relies on a type augmentation that only a test or a config file loads needs it in its own tsconfig. A Vite plugin that returns `test` from its `config` hook needs Vitest's augmentation of the Vite config: add `"types": ["vitest/config"]` to `tsconfig.module.json`, or `/// <reference types="vitest/config" />` to that file.
- **`erasableSyntaxOnly` outside the Node entry** (TS1294). `erasableSyntaxOnly` in `tsconfig.module.json` also applies to other bundled entries next to `src/module.ts`, such as a `src/vite.ts` or `src/unplugin.ts`, and to every file module code imports, runtime files included, which don't have to load with Node. Rewrite the syntax there too. A bundled entry that module code doesn't import can instead be left out of its `include`; a file that module code imports stays in its program either way.
- **App code in the server part** (TS2307 for `#app`, TS2305 and TS2724 for app composables in `#imports`, TS2304 and TS2584 for `window` and `document`, TS2724 for typed routes such as `RouteMapI18n`). A server file that imports an app runtime file or module code gets that file type checked with the server's types, which have no `#app`, no app composables in `#imports`, no DOM globals, and none of the app's typed routes. Move what both parts use into files that only depend on what both have. Code in a server file that runs in a browser, such as a function passed to Playwright's `page.evaluate`, needs `/// <reference lib="dom" />` in that file.
- **A runtime config type declared twice** (TS2322, TS2345, TS2339). A runtime config key whose type the module declares, through `ModulePublicRuntimeConfig` or its own augmentation of `RuntimeConfig` or `PublicRuntimeConfig`, is also typed by Nuxt from the value the module sets. When the two types differ, TypeScript uses the declaration it reads first, or merges the two into a type that lacks properties of either, and the result differs between the layouts. Make the two types agree, or declare the full type.
- **`default` refers to itself** (TS7022 on the default export, TS7023 on a function in it, such as `moduleDependencies`). The module's own `.nuxt/types/modules.d.ts` types its options key and its entry in `ModuleDependencies` from `typeof import('../../src/module').default`. A `moduleDependencies` function without a return type is inferred from that same export. Give it one: `moduleDependencies(nuxt): ModuleDependencies`, with `ModuleDependencies` from `@nuxt/schema`.
- **An ambient module declared twice** (TS2554, TS2748, or a wrong type for an export). A `.d.ts` in the module that declares an ambient module a type template also declares, such as `declare module '#my-module/bindings'` in both, applies to each part along with the template, and the two declarations merge. Keep one of them.
- **Errors in code that relies on `.nuxt`'s declarations**. A `tsconfig.json` whose own `include` replaces the one it extends, such as `"include": ["src"]`, leaves out `.nuxt/nuxt.d.ts` and the declarations it references, such as the module's runtime config, typed routes and type templates. Each part here has them, so code that relies on them is checked against them. Fix what they report.
- **Module code that a runtime file imports by relative path** (TS2339 on `nuxt.options`, TS2307 for `#app`). A runtime file that imports from `src/module.ts` or another file of module code by relative path, such as `import type { ImageProvider } from '../../module'`, brings that file into the type check of its own part. The server and shared parts don't have the module's augmentations, so `nuxt.options.<key>` from one of them fails there, and so do the imports that module code makes. Import the type through the module's own package name instead, `import type { ImageProvider } from 'my-module'`, which these parts resolve to the declarations of module code that `prepare` writes. Or import it from a file that only declares types.
- **Vite's module types not found** (TS2307 for an import such as `./worker.ts?worker&url` or `./styles.css?inline`, TS2882 for `import './styles.css'`). No part has the types of `vite/client`, as in an app, where Nuxt only types `import.meta`. Add `vite` to the module's `devDependencies`, and a `.d.ts` in the module root, such as `env.d.ts`, with `/// <reference types="vite/client" />`. It applies to every part, as described in [Generated tsconfigs](#generated-tsconfigs).
- **Errors in tests under `test/nuxt`** (TS2593 for `describe` and `it`, and other errors in tests). The app's tsconfig includes `test/nuxt` and `tests/nuxt`, so these tests are checked with the app's types and without a test runner's globals. Import `describe` and `it` from `vitest`, or leave the directory out with the root's `exclude`, such as `"exclude": ["dist", "node_modules", "playground", "test"]`, and type check tests with a tsconfig of your own.
- **Errors in a template that the module generates** (such as TS7006 in a `.ts` template). A template with a `.ts` file name that a runtime file imports, through an alias or `#build`, is type checked in that file's part, with its options. Type the code that the template generates, such as the parameters of its functions.
- **Excessive stack depth** (TS2321). TypeScript stops comparing two deeply nested types once the comparison is too deep, and which comparisons get that far depends on the types in the program. Give the value an explicit type, so that its inferred type isn't compared.
- **An unused `@ts-expect-error`** (TS2578). The directive suppressed an error that a single-program check reported, and the part that checks the file now has no error there. Remove the directive. If another check of the same file still reports the error, such as the playground's check with source exports, use `// @ts-ignore` on that line instead.

### Extending .nuxt/tsconfig.json

`prepare` also writes `.nuxt/tsconfig.json`, for a `tsconfig.json` that extends it. It type checks the whole module root as one program with the app's types, so it doesn't report the errors in [Type checking each part](#type-checking-each-part), and in it the module's own package name resolves through `package.json` rather than to declarations of module code. Set `erasableSyntaxOnly` in its own `compilerOptions`, and type check with `vue-tsc --noEmit`:

```json
{
  "extends": "./.nuxt/tsconfig.json",
  "compilerOptions": {
    "erasableSyntaxOnly": true
  },
  "exclude": ["dist", "node_modules", "playground"]
}
```

### Other tsconfig layouts

The tsconfig that covers your module might extend or reference a playground's `.nuxt/tsconfig.json` instead. This can be the module's own tsconfig or a monorepo root's, such as `../../tsconfig.json`. In that case, the build generates declarations with `./.nuxt/tsconfig.json` plus that tsconfig's own `compilerOptions`, and prints a note saying so. `types` and `paths` are included, apart from paths into the playground's `.nuxt`.

In a monorepo, give the module a `tsconfig.json` and a `tsconfig.module.json` of its own as shown above, in the module's directory. Copy into its `compilerOptions` the entries of the repository root's `compilerOptions.types` that the module's `src` relies on, such as `"youtube"` and `"google.maps"` for global namespaces, and leave out those only tests or other packages use, such as `"vitest/globals"`. They then apply to the module's own type check as well as to the build.

The declaration program starts from your module's own files only. Files the tsconfig includes outside the module root (a workspace, with `typescript.includeWorkspace`) are left out. So are files under the module's `playground*`, `docs`, `test`, `tests`, `fixtures`, `example`, and `examples` directories. Their routes and type augmentations therefore don't end up in `dist`. Files that your module's sources import are still followed, wherever they are.

## Preparing .nuxt

Declarations are generated against the tsconfigs in `.nuxt`, so a build runs `nuxt-module-build prepare` first when `.nuxt` is missing. `prepare` loads `src/module.ts` with Node, so the rules in [Module code loads with Node](#module-code-loads-with-node) are checked there too. Keep `prepare` first in your module's `dev:prepare` script, as in [Developing a module](#developing-a-module), so the build doesn't have to:

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

Run `dev:prepare` after you install dependencies, and again when the module registers something new for types, such as a template or a server route. With the tsconfigs in [Module tsconfig](#module-tsconfig), the module's own app, server and shared type checks see the types of module code as of the last `prepare`.

The scripts in the following sections hold only the builder's commands and the playground's. Keep any other commands of your own scripts, as described in [Scripts](#scripts).

### Source exports

pnpm and Yarn 4 publish the fields of `publishConfig` in place of the top-level ones. With either of them, point `exports`, `imports`, and `main` at `src`, and the same fields in `publishConfig` at `dist`. The playground then loads the module from its sources, with no build. Packing replaces each field as a whole, so `publishConfig.exports` and `publishConfig.imports` repeat every subpath and condition:

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
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/types.d.mts", "style": "./dist/runtime/index.css", "default": "./dist/module.mjs" },
      "./utils": { "types": "./dist/utils.d.mts", "default": "./dist/utils.mjs" }
    },
    "imports": {
      "#shared/*": "./dist/runtime/shared/*.js"
    },
    "main": "./dist/module.mjs"
  },
  "scripts": {
    "dev": "nuxt dev playground",
    "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground",
    "prepack": "tsdown"
  }
}
```

`nuxt-module-build prepare` writes `.nuxt/module-builder/types.d.mts`. It re-exports `src/module.ts` and declares the same `#app` and `@nuxt/schema` augmentations as `dist/types.d.mts`, for the module's `ModuleHooks`, `ModuleRuntimeHooks`, `ModuleRuntimeConfig`, and `ModulePublicRuntimeConfig`. The root export's `types` condition points at it, so the playground's type check sees the module's hooks and runtime config. A module that supports `node10` consumers also sets `publishConfig.types` to `./dist/types.d.mts` (see [The types field](#the-types-field)). A subpath export has no augmentations, so it points at its source.

The playground's type check includes the module's sources and the files that they import types from. A built `dist` keeps them out, because the type check doesn't check declarations. The type check can report these errors:

- **`#app`, `#imports`, or `#build/*` not found (TS2307, TS2664) in the `nuxt.config.ts` context.** Module code imports types from a runtime file that uses these aliases. Move those types into a file that doesn't import the aliases, such as `src/runtime/types.ts`.
- **Relative imports without extensions (TS2835, TS2834) in the `nuxt.config.ts` context.** This context resolves imports like Node when the playground sets `future.compatibilityVersion: 5`. Add extensions to type-only relative imports as well.
- **Globals that the module declares in its own `.d.ts` not found (TS2304).** The playground doesn't include that file. Reference it with `/// <reference path="..." />` from the files that use the globals.
- **The module's own aliases not found (TS2307).** Move each alias from the module's tsconfig `paths` into the `imports` of `package.json`, with its `dist` paths in `publishConfig.imports`. TypeScript resolves those from the module's files in any project.
- **A virtual module that the module adds not found (TS2307).** Declare its types with `addTypeTemplate(template, { nuxt: true, node: true })` from `@nuxt/kit`, so both of the playground's contexts include them.
- **Other errors in runtime files.** The playground checks them with its own compiler options. Fix them, or check the module with the same options.

With source exports, there is no `dist` while you develop. Code that reaches into `dist` by path has to point at `src`, such as a test that imports `../dist/runtime/...`, or module code that resolves `../dist/runtime/...`. Resolve runtime files relative to `src/module.ts`, without an extension:

```ts
// src/module.ts
const resolver = createResolver(import.meta.url)
addPlugin(resolver.resolve('./runtime/plugins/plugin'))
```

The build keeps the layout of `src` in `dist`, and Nuxt and Vite add the extension.

Build-time code that reads a runtime file's contents, such as code that inlines the file into a template, finds no file at the path without an extension, and TypeScript at the `.ts` path. Generate the template from code that doesn't depend on the built file, or build `dist` first and keep reading from it.

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

The check reads `npm_lifecycle_event`, so it only runs when `tsdown` or `nuxt-module-build build` is a command of the `prepack` or `prepublishOnly` script itself, such as `"prepack": "tsdown && pnpm build:client"`. A `prepack` script that runs another script, such as `"prepack": "npm run build"`, isn't checked: the nested script runs as `build`. Run the build from `prepack` directly, as in [Scripts](#scripts).

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
  "scripts": {
    "dev": "nuxt dev playground",
    "dev:prepare": "nuxt-module-build prepare && tsdown && nuxt prepare playground",
    "prepack": "tsdown"
  }
}
```

A playground that installs the module by name lists it as `"my-module": "workspace:*"` or `"my-module": "link:.."`. npm supports neither protocol, so use `"my-module": "file:.."` there. npm installs it as a link. Yarn 1 has no `workspace:` protocol, so use `link:..` there.

`nuxt-module-build prepare` installs the module from its sources even where its own `.nuxtrc` or `nuxt.config` lists it by name. Any other `nuxt prepare` that loads the module by name, such as one at the repository root with `modules[]=my-module` in `.nuxtrc`, loads it from `dist` and leaves it out when `dist` is missing. Run `tsdown` before such a `nuxt prepare` in `dev:prepare`.

While `nuxt dev playground` runs, run `tsdown --watch` next to it. `tsdown --watch` leaves `dist` in place while its first build runs, so the two can start together. Each change under `src` rebuilds `dist`, in about a second for a small module, or less with [isolated declarations](#isolated-declarations). A rebuild only writes the files whose content changed, so the playground updates an edited component in place, and reloads the page for an edited plugin. The playground loads `dist/module.mjs` once, when `nuxt dev` starts: restart `nuxt dev` after changing module code.

## Checking the package

[attw](https://arethetypeswrong.github.io) checks the types of the packed tarball. It reports three kinds of problem for a module that is correct:

- `CJSResolvesToESM`, under `node16` from CommonJS. The module is an ES module, which `require` can't load.
- `NoResolution`, under `node10`, for each subpath export of a module without `typesVersions`, as described in [The types field](#the-types-field).
- `InternalResolutionError`, for an import in a declaration file that doesn't resolve from the package alone. The declarations keep imports of `#app`, `#imports`, `#build/*` and the module's other build-time aliases as written, as described in [Other type errors](#other-type-errors), and only a Nuxt app resolves them. Under `node10`, the package's own `imports`, such as `#my-module/types`, don't resolve either. That is only expected for a module without `node10` consumers: one that supports them imports those files by relative path in the code that the declarations come from.

`--profile esm-only` leaves out `node10` and `require` under `node16`, which covers the first two. It doesn't cover the third: attw reports an `InternalResolutionError` under `node10` even with that profile, and exits with an error when every resolution it shows is green.

`--ignore-rules internal-resolution-error` leaves out every import that doesn't resolve, a wrong relative import included. Before you ignore them, list them, and check that each one is an alias that only a Nuxt app provides:

```bash
pnpm dlx @arethetypeswrong/cli my-module-1.0.0.tgz --profile esm-only --format json | jq -r '.analysis.problems[] | select(.kind == "InternalResolutionError") | "\(.resolutionOption) \(.moduleSpecifier) \(.fileName)"' | sort -u
```

Then check the package with the rule ignored:

```bash
pnpm dlx @arethetypeswrong/cli my-module-1.0.0.tgz --profile esm-only --ignore-rules internal-resolution-error
```

A module that sets `types` and `typesVersions` for `node10` consumers checks `node10` as well:

```bash
pnpm dlx @arethetypeswrong/cli my-module-1.0.0.tgz --ignore-rules cjs-resolves-to-esm internal-resolution-error
```

`attw --pack .` only works with npm, and `npm pack` fails on packages with `devEngines`, so pack the module with its own package manager first.

## Output size

Every tsdown build reports the size of its output. A module with runtime directories gets a summary, followed by one line for each bundled entry and runtime directory. Each line gives the size of the code and of the declarations. Other modules get a line for each file.

On a rebuild under `tsdown --watch`, the summary and the lines for each file only count the files that the rebuild wrote. The lines for each entry and runtime directory cover the whole build. `module.json` and `types.d.mts` are written after the report, so they aren't in it.

Set `report` in `tsdown.config.ts` to change the report:

- `{ summary: true }` or `{ summary: false }` chooses between the summary and the lines for each file.
- `{ gzip: false }` skips compressing each file.
- `{ brotli: true }` adds the brotli size.
- `false` turns the report off.

To check the published size in CI, pack the module with the package manager that publishes it, into a temporary directory. Then list the tarball with `npm pack --dry-run --json`, which gives each file's `size`, plus the gzipped tarball's `size` and the `unpackedSize`. `pnpm pack --json` lists the files without their sizes.

```bash
pack_dir=$(mktemp -d)
pnpm pack --pack-destination "$pack_dir"
npm pack --dry-run --json "$pack_dir"/*.tgz | jq '.[0] | { size, unpackedSize, files: [.files[] | { path, size }] }'
```

With `package.json` pointing at `dist`, `npm pack --pack-destination "$pack_dir"` packs it the same way.

## Removed dependencies

`unbuild`, `mkdist`, `jiti`, `defu`, and `magic-regexp` are no longer installed with `@nuxt/module-builder`. If your module imports any of them in its own code, add it to the module's own dependencies.

Remove `unbuild` from your module's `devDependencies`. Remove `mkdist` and `jiti` too, when they only served the builder:

```bash
pnpm remove unbuild
```

## Checklist

Follow these steps in order to upgrade a module. Where a step says `pnpm`, use your module's own package manager. Run the commands that a step names with its `exec`, such as `pnpm exec tsdown`, and the scripts with its `run`, such as `pnpm run dev:prepare`.

1. Use Node 22.18+, 24.11+, or 26+ locally and in CI.
2. Install v2 and tsdown, before step 3:
   - Run `pnpm add -D @nuxt/module-builder@^2.0.0 tsdown@^0.23.7`.
   - If `unbuild` is in `devDependencies`, run `pnpm remove unbuild`. Also remove `mkdist` and `jiti`, if they only served the builder.
3. Move the build options into a `tsdown.config.ts`:
   - Move the options of `build.config.ts`, and of the `build` or `unbuild` field of `package.json`, into `builder()`. Include directory entries such as `{ input: 'src/x/', outDir: 'dist/x' }`. See [Moving from build.config.ts](#moving-from-buildconfigts).
   - Delete `build.config.ts`, and remove the field.
   - A module without options still needs a `tsdown.config.ts` with `plugins: [builder()]`, so that `tsdown` builds it.
4. Update the declaration paths in `package.json`:
   - Replace `.d.ts` with `.d.mts` for `types.d.ts` and `module.d.ts`.
   - Replace `module.cjs` with `module.mjs`, and remove `.cjs` entries.
   - Decide whether your module supports `node10` consumers: projects that import it and type check with `"moduleResolution": "node"` or `"node10"`, or with `"module": "commonjs"` and no `moduleResolution`. An app on Nuxt 4 isn't one. See [The types field](#the-types-field).
   - If it doesn't, remove the top-level `types` field and `typesVersions`. Subpath exports then don't resolve under `node10`, which step 10 leaves out of its check.
   - If it does, set `types` to `./dist/types.d.mts`, in `publishConfig` with source exports (see step 8). Give every `typesVersions` path its full file name: `./dist/util.d.mts`, not `dist/util`.
5. Make module code load with Node. See [Module code loads with Node](#module-code-loads-with-node):
   - Add the `.ts` extension to relative imports in `src/module.ts` and the files that it imports by value, runtime files included. `./utils` becomes `./utils.ts`, and `./dir` becomes `./dir/index.ts`.
   - Replace value imports through tsconfig `paths` aliases.
   - Move value imports of `#app`, `#imports`, and `#build/*` into runtime files.
   - Rewrite any `enum`, `namespace` with values, parameter property, or `<T>value` assertion in these files.
   - If module code imports files that a build hook generates, generate them before `prepare`, as described in [Hooks in a tsdown config](#hooks-in-a-tsdown-config).
   - In a monorepo whose module has no tsconfig of its own, create its `tsconfig.json` and `tsconfig.module.json` first, as shown in step 6. Otherwise `prepare` reads the repository root's tsconfig, which can extend a `.nuxt` that only the root's own `nuxt prepare` writes.
   - Run `nuxt-module-build prepare`. Until module code loads with Node, it lists each problem with its fix, and doesn't generate `.nuxt`. Fix them all and run it again, until it generates `.nuxt`.
6. Move the module to the tsconfigs in [Module tsconfig](#module-tsconfig):
   - Replace `tsconfig.json` with the root shown there: `"files": []`, the `references` to `./tsconfig.module.json` and to `./.nuxt/tsconfig.app.json`, `tsconfig.server.json` and `tsconfig.shared.json`, and the old `exclude`.
   - Keep the old `compilerOptions` in the root, apart from `types` that only tests or other tools use, such as `"vitest/globals"`: `prepare` copies the root's options, `types` included, into every part. Path options such as `paths` and `baseUrl` aren't copied: move an alias from `paths` into the `imports` of `package.json`, as described in [Source exports](#source-exports). Move `erasableSyntaxOnly` and any other option for module code only into `tsconfig.module.json`.
   - Create `tsconfig.module.json` as shown there, with `"erasableSyntaxOnly": true` and `tsBuildInfoFile`.
   - Drop the old `include`. The generated tsconfigs cover `src`, and the module's `.d.ts` files are added to them, as described in [Generated tsconfigs](#generated-tsconfigs). A `.d.ts` that an `include` named in an excluded directory, such as `test/`, applies to none of them: move it into `src` or the module root.
   - In a monorepo, both files are in the module's directory, as created in step 5 and described in [Other tsconfig layouts](#other-tsconfig-layouts).
   - In the type-check script, replace the module's own `vue-tsc --noEmit` or `tsc --noEmit` with `vue-tsc -b --noEmit`, and keep the rest of the script. `vue-tsc --noEmit && nuxt typecheck playground` becomes `vue-tsc -b --noEmit && nuxt typecheck playground`. Replace a `nuxt typecheck` of the module root, without a directory, the same way: it regenerates `.nuxt` as an app's. Without a type-check script, add `"test:types": "vue-tsc -b --noEmit"`.
   - If `vue-tsc` isn't in `devDependencies`, run `pnpm add -D vue-tsc`. At the root of a pnpm workspace, add `-w`: `pnpm add -D -w vue-tsc`.
   - Run `nuxt-module-build prepare` and the type-check script. It checks each part with the types that part has in an app, so it can report errors that a single-program check didn't. [Type checking each part](#type-checking-each-part) lists them, with their fixes.

   To keep a `tsconfig.json` that extends `./.nuxt/tsconfig.json`, set `erasableSyntaxOnly` in it instead, and keep `vue-tsc --noEmit`, as described in [Extending .nuxt/tsconfig.json](#extending-nuxttsconfigjson).
7. If the runtime contains `.scss` or `.sass` files, run `pnpm add -D sass`.
8. Set up the scripts, and build. In every script that runs the builder, under any of its names (`nuxt-module-build`, `nuxt-build-module` or `nuxt build-module`, see [Commands](#commands)), change only the builder's commands, as shown in [Scripts](#scripts), and keep the others:
   - `nuxt-module-build build` becomes `tsdown`, in `prepack` and in any other script or CI workflow that runs it.
   - With pnpm or Yarn 4, point `package.json` at the module's sources, and the same fields in `publishConfig` at `dist`. See [Source exports](#source-exports). Remove `nuxt-module-build build --stub` from `dev:prepare`. A subpath that code outside Nuxt loads with Node, such as a Vite plugin at `my-module/vite` that a plain Vite app imports, keeps pointing at `dist`, as described in [Source exports](#source-exports): step 5 only checks the files that module code imports, so Node can fail on that subpath's source, with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, after every step passes.
   - With npm, Yarn 3 or earlier, or bun, keep `package.json` pointing at `dist`. See [Developing against dist](#developing-against-dist). In `dev:prepare`, replace `nuxt-module-build build --stub` with `tsdown`, or add `tsdown` before the first `nuxt prepare`.
   - Put `nuxt-module-build prepare` in `dev:prepare` before the build and every `nuxt prepare`, if it isn't there.
   - Keep commands that write into `dist` after `tsdown`, as the build empties `dist` first.
   - With source exports, run `tsdown` from `prepack` itself, so that the pack checks in [Publishing source exports](#publishing-source-exports) run. A `prepack` that chains other commands, such as `tsdown && pnpm build:client`, is checked. One that runs another script, such as `pnpm run build`, isn't: move that script's commands into `prepack`.
   - Run the `dev:prepare` script, then `tsdown`.
   - Fix what the build reports. Remove each unsupported build option, and annotate each export in a portability error. Build again until the build passes, then run the `prepack` script once, so that its other commands run too.
9. Run your module's type-check script again, and fix what it reports, as described in [Type checking each part](#type-checking-each-part):
   - You can ignore a build warning about type errors that the type check doesn't reproduce.
   - Annotate exports whose type is inferred through a `#build/*` alias. Otherwise, `dist` declares them as `any`.
10. Check the package:
    - Run `pnpm dlx publint`.
    - Run `pnpm pack`, then run attw on the tarball it writes, such as `my-module-1.0.0.tgz`, as described in [Checking the package](#checking-the-package): list the imports that don't resolve, check that each of them is an alias that only a Nuxt app provides, then run `pnpm dlx @arethetypeswrong/cli my-module-1.0.0.tgz --profile esm-only --ignore-rules internal-resolution-error`. If you kept `types` and `typesVersions` in step 4, check `node10` as well, with `--ignore-rules cjs-resolves-to-esm internal-resolution-error` and no `--profile`.
    - Fix any path that they report.
11. Run your module's tests and the playground.
