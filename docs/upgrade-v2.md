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

`build.config.ts` and the `unbuild` field of `package.json` are deprecated. The build still reads them and applies these options:

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

Entries belong in the `build.entries` field of `package.json`, which isn't deprecated. It accepts the same shapes as `build.config.ts` did. A string or `{ input, name }` object is a bundled entry. An object with an input that ends in `/` (or with `builder: 'mkdist'`) is a directory transpiled file by file. When entries are the only option left in `build.config.ts`, delete the file:

```json
{
  "build": {
    "entries": [
      "./src/utils",
      { "input": "src/features/", "outDir": "dist/features", "ext": "js" }
    ]
  }
}
```

A directory entry's `outDir` must be inside `dist`. Its `ext` is `mjs` (the default) or `js`, and the declarations next to the scripts use the matching `.d.mts` or `.d.ts`. An `unbuild` field in `package.json` is read the same way but is deprecated: rename it to `build`.

Any other option fails the build with the list of [unsupported build options](#unsupported-build-options).

## Unsupported build options

The build fails with a list of every option it can't apply and the file each one comes from. `nuxt-module-build build --stub` prints the same list as a warning and continues. Remove each option as described in the following sections, then build again.

### Hooks

Only `build:before`, `rollup:done`, and `build:done` run. They receive a context with `options.name`, `options.rootDir`, `options.outDir`, `options.entries`, `options.declaration`, `options.stub`, `options.sourcemap`, and `pkg`.

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

- `stub` and `stubOptions`: use `nuxt-module-build build --stub` instead.
- `clean: false`: the output directory is always emptied.
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

`nuxt-module-build build --stub` writes `dist/module.mjs` and `dist/module.d.mts` as re-exports of `src/module.ts`. Whatever imports the stub, such as a playground's Nuxt, loads the TypeScript sources with its own loader. The builder loads them with Node's type stripping, which only erases types. Files with JSX, `enum`, `namespace`, parameter properties, `<T>value` assertions, `import =`, `export =`, or decorators are transpiled with oxc, which comes with `tsdown`.

Without `tsdown`, the stub build fails and lists every file, line, and column that uses such syntax. Rewriting it keeps the sources loadable by Node alone. Set `erasableSyntaxOnly` so the type checker reports it too, then rewrite each occurrence:

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true
  }
}
```

```ts
// before
export enum Mode { Light, Dark }

// after
export const Mode = { Light: 0, Dark: 1 } as const
export type Mode = typeof Mode[keyof typeof Mode]
```

## Import extensions in module code

Relative imports in `src/module.ts`, and in every file it imports outside the runtime directories, carry the imported file's extension: `./utils.ts`, not `./utils`, `./utils.js`, or `./dir`. The stub re-exports these sources as they are, and Node resolves relative specifiers as written. The generated `.nuxt/tsconfig.json` sets `allowImportingTsExtensions`, so the `.ts` form type checks without further settings.

The build lists every specifier that doesn't name a file, with the one to write instead, and stops:

```ts
// before
import { helper } from './utils'
import { kit } from './kit'

// after
import { helper } from './utils.ts'
import { kit } from './kit/index.ts'
```

Type-only imports are erased before Node loads the file, so `import type { X } from './types'` is accepted. Files under `src/runtime` (and other transpiled directories) keep extensionless imports: those are emitted with the extension added. The same rule applies to `build.config.ts` and to `nuxt-module-build prepare`, which loads `src/module.ts` the same way.

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
- A relative import of a file outside `src/runtime` is emitted where the import points (`src/shared/x.ts` becomes `dist/shared/x.js`). When that would leave `dist` or collide with another output, it's emitted under `dist/_external/` instead. A file that is only imported as a type gets a `.d.ts` and no script.
- Your module's own package name and `#` subpath imports are never bundled into `module.mjs`.

## Output directory

The build empties `--outDir` (`dist` by default) before writing to it, so the directory must be inside your module. An `--outDir` of `.`, or of a directory that contains the module, fails the build.

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

Declarations are generated against `.nuxt/tsconfig.json`, so `nuxt-module-build build` runs `nuxt-module-build prepare` first when `.nuxt` is missing. `prepare` loads `src/module.ts` with the same loader as `--stub`, so [import extensions](#import-extensions-in-module-code) are checked there too. Keep `prepare` in your module's `dev:prepare` script so the build doesn't have to:

```json
{
  "scripts": {
    "dev:prepare": "nuxt-module-build build --stub && nuxt-module-build prepare && nuxi prepare playground",
    "prepack": "nuxt-module-build build"
  }
}
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
3. In `build.config.ts`, change `from 'unbuild'` to `from '@nuxt/module-builder'`. Move `entries` to the `build.entries` field of `package.json`, including directory entries such as `{ "input": "src/x/", "outDir": "dist/x" }`. Delete the file if nothing else is left. Rename a `package.json` `unbuild` field to `build`.
4. In `package.json`, replace `.d.ts` with `.d.mts` for `types.d.ts` and `module.d.ts`, replace `module.cjs` with `module.mjs`, and remove `.cjs` entries. Set the top-level `types` field to `./dist/types.d.mts`, or remove it. Give every `typesVersions` path its full file name (`./dist/util.d.mts`, not `dist/util`).
5. Add `"erasableSyntaxOnly": true` to `tsconfig.json`, and rewrite any `enum`, `namespace`, parameter property, or `<T>value` assertion the type check reports.
6. Add the `.ts` extension to relative imports in `src/module.ts` and the files it imports outside `src/runtime` (`./utils` becomes `./utils.ts`, `./dir` becomes `./dir/index.ts`). The build lists each one that is missing.
7. If the runtime contains `.scss` or `.sass` files, run `pnpm add -D sass`.
8. Run `nuxt-module-build prepare`, then `nuxt-module-build build`. Fix what the build reports: remove each unsupported build option and annotate each export in a portability error. Build again until it passes.
9. Run your module's own type check (for example, `nuxt typecheck` or `vue-tsc --noEmit`) and fix what it reports. A build warning about type errors that the type check doesn't reproduce is safe to ignore. Annotate exports whose type is inferred through a `#build/*` alias; otherwise `dist` declares them as `any`.
10. Run `pnpm dlx publint`. Then run `pnpm pack` and `pnpm dlx @arethetypeswrong/cli <name>-<version>.tgz`, and fix any path they report. (`attw --pack .` only works with npm, and `npm pack` fails on packages with `devEngines`.)
11. Run your module's tests and the playground against `dist`.
