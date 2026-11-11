# Upgrading to @nuxt/module-builder v2

Version 2 builds modules with [tsdown](https://tsdown.dev) instead of unbuild. The CLI, the project layout (`src/module.ts`, `src/runtime/`) and the output files (`dist/module.mjs`, `dist/module.json`, `dist/types.d.mts`, `dist/runtime/**`) are unchanged. The build prints a link to the relevant section below for everything it needs you to change. A [checklist](#checklist) at the end lists every step in order.

## Node engines

`@nuxt/module-builder` v2 runs on Node `^22.18.0 || >=24.0.0`, and `tsdown` on `^22.18.0 || ^24.11.0 || >=26.0.0`. Use Node 22.18 or later, or 24.11 or later, wherever the module is built, including CI.

```yaml
# .github/workflows/ci.yml
strategy:
  matrix:
    node: [22, 24]
```

## Install tsdown

`tsdown` is a peer dependency, so the module installs it itself. Install it together with v2, before touching `build.config.ts`: the `defineBuildConfig` export that the next section imports only exists in v2.

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

Then remove the packages that were only there for the old builder; see [Removed dependencies](#removed-dependencies).

## Build configuration

`build.config.ts` (and `build.config.mts`, `.js`, `.mjs`) and the `unbuild` field of `package.json` are deprecated. They are still read, and these options are applied:

- `entries`: strings and `{ input, name }` are bundled as extra entries; `builder: 'mkdist'` entries (or an input ending in `/`) are transpiled file by file.
- `externals`: package names and regular expressions that are never bundled.
- `replace` and `rollup.replace`: compile-time replacements in the module entry.
- `hooks['build:before']`, `hooks['rollup:done']` and `hooks['build:done']`.
- `declaration`, `sourcemap`, `failOnWarn`, `name`, `parallel`, `clean: true`, and `rootDir` / `outDir` at their defaults.

`unbuild` is no longer installed with `@nuxt/module-builder`, so change the import (after [installing v2](#install-tsdown)):

```ts
// build.config.ts, before
import { defineBuildConfig } from 'unbuild'

// build.config.ts, after
import { defineBuildConfig } from '@nuxt/module-builder'
```

Entries belong in the `build.entries` field of `package.json`, which is not deprecated. It takes the same shapes as `build.config.ts` did: a string or `{ input, name }` for a bundled entry, and `{ input: 'src/<dir>/', outDir, ext }` (an input ending in `/`, or `builder: 'mkdist'`) for a directory transpiled file by file. When entries are the only option in `build.config.ts`, delete the file:

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

A directory entry's `outDir` has to be inside `dist`, and `ext` is `mjs` (the default) or `js`; the declarations next to the scripts use the matching `.d.mts` or `.d.ts`. An `unbuild` field in `package.json` is read the same way, but is deprecated: rename it to `build`.

Any other option fails the build with the list of [unsupported options](#unsupported-build-options).

## Unsupported build options

The build stops with a list of every option it cannot apply and the file each one came from. `nuxt-module-build build --stub` prints the same list as a warning and carries on. Remove each option as described below, then build again.

### Hooks

Only `build:before`, `rollup:done` and `build:done` run. They receive a context with `options.name`, `options.rootDir`, `options.outDir`, `options.entries`, `options.declaration`, `options.stub`, `options.sourcemap` and `pkg`.

- `mkdist:*` hooks are ignored with a warning. Remove them; see [mkdist options](#mkdist-options) for what they used to configure.
- Every other hook (`rollup:options`, `build:prepare`, `rollup:dts:options` and so on) fails the build. Remove it. Hooks that adjusted rollup options are covered under [Rollup options](#rollup-options).

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

The module entry is bundled with tsdown's defaults for a Node library. `rollup.*` options and the `rollup:options` hook have no equivalent and fail the build. Remove them. The exceptions are `rollup.replace`, which is applied, `rollup.emitCJS: false`, `rollup.cjsBridge: false` and `rollup.output.exports`, which are accepted because they describe the default output.

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

The build emits ES modules only. `rollup.emitCJS: true` fails the build. Remove it, remove the `.cjs` files from `package.json`, and point `main` at `module.mjs`:

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

With the CommonJS output, the `.d.ts` files that `typesVersions` entries relied on go too; see [typesVersions paths](#typesversions-paths).

### mkdist options

Runtime files are transpiled with oxc, one file at a time, with their imports kept as written. Options that configured mkdist (`esbuild`, `pattern`, `declaration` on an entry, `format`, postcss plugins passed through `mkdist:entry:options`) have no equivalent and fail the build. Remove them. `ext` and `addRelativeDeclarationExtensions` on a directory entry are accepted when they match what the build produces anyway.

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

These also fail the build:

- `stub` and `stubOptions`: use `nuxt-module-build build --stub`.
- `clean: false`: `dist` is always cleaned.
- `rootDir` or `outDir` set to anything other than the module root and `dist`.
- An array of more than one config: keep a single config object.
- A config that exports a function.
- Any key that unbuild did not define.

## package.json paths

After every build, `package.json` is checked for paths the build did not produce.

### Declaration paths

The module entry's declarations are `dist/types.d.mts` and `dist/module.d.mts`. Replace `.d.ts` with `.d.mts` in `exports`, `types` and `typesVersions`:

```json
{
  "exports": {
    ".": {
      "types": "./dist/types.d.mts",
      "import": "./dist/module.mjs"
    }
  },
  "typesVersions": {
    "*": {
      ".": ["./dist/types.d.mts"]
    }
  }
}
```

### module.cjs

`dist/module.cjs` is not generated. Replace it with `./dist/module.mjs` in `main`, `exports` and anywhere else it appears. See [CommonJS output](#commonjs-output) for the `exports` shape.

### The types field

A top-level `types` field is not needed with `"moduleResolution": "bundler"`, which Nuxt projects use. Remove it. Add `typesVersions` for subpath exports if the module also supports `node10` resolution.

### typesVersions paths

TypeScript resolves `typesVersions` entries with node10 rules: a path without an extension is probed as `.ts`, `.tsx`, `.d.ts` and `/index.d.ts`, never as `.d.mts`. The build now produces `.d.mts` for every bundled entry, so an extensionless entry stops resolving. The build warns with the file to use; write each path with its extension:

```json
{
  "typesVersions": {
    "*": {
      "util": ["./dist/util.d.mts"]
    }
  }
}
```

`publint` does not report this; `attw` does, as a resolution failure in its `node10` column.

### Paths the build does not produce

Any other path in `exports`, `main`, `module`, `types` or `typesVersions` that does not exist after the build is listed in a warning. Either add the entry that produces it (see [Build configuration](#build-configuration)), or remove the path.

## Stub builds

`nuxt-module-build build --stub` writes `dist/module.mjs` and `dist/module.d.mts` as re-exports of `src/module.ts`, and Node loads the TypeScript sources directly. With `tsdown` installed, the sources are transpiled with oxc on load, so any TypeScript syntax works. Without it, Node's own type stripping is used, which only erases types: `enum`, `namespace`, parameter properties, `<T>value` assertions and legacy decorators fail to load.

Either way the build lists every file, line and column that uses such syntax. Set `erasableSyntaxOnly` so the type checker reports it too, and rewrite the few places that use it:

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

## Declaration errors

Declarations for the module entry and for `src/runtime` are generated with TypeScript, using the module's own `tsconfig.json` (so run `nuxt-module-build prepare` first; see [Preparing .nuxt](#preparing-nuxt)). Errors that would make the declarations missing or wrong fail the build; every other type error, in `.ts` and `.vue` files alike, is reported as a warning.

### Portability errors

An export whose inferred type refers to a package the module cannot import by name (a dependency of a dependency, or another version of a package the module depends on) fails the build with TS2742, TS2883, TS4023 or another declaration emit error, in a `.ts` file or a `.vue` file. The error lists each export with its file and line. Give each one an explicit type annotation.

When the value comes from a function the module imports, annotate with that function's return type. This follows whichever version of the package the function is from, which a named type import does not:

```ts
// before
export const handler = defineCachedHandler(...)

// after
export const handler: ReturnType<typeof defineCachedHandler> = defineCachedHandler(...)
```

Otherwise import a type from a package the module depends on directly:

```ts
import type { EventHandler } from 'h3'

export const handler: EventHandler = defineEventHandler(...)
```

Syntax errors and files for which no declaration could be emitted fail the build as well.

### Other type errors

Type errors that do not change the declarations (a wrong argument type, a missing property and so on) do not fail the build, whether they are in a `.ts` file or a `.vue` file. One warning per directory gives their number and the first three. Run the module's own type check, for example:

```bash
nuxt typecheck
# or
vue-tsc --noEmit
```

If it reports the same errors, fix them there. If it passes, the errors come from build-time aliases (`#build/*`, `#internal/*` and other paths into `.nuxt/`) being typed as `any` while declarations are generated, and can be ignored. The types in the module's `.nuxt` also reflect the module's default options, so code that only type-checks under a playground's configuration (a provider the playground enables, say) warns here as well; an explicit annotation on the export removes the warning.

Those aliases are `any` in the emitted declarations too. An export whose type is inferred through one of them (a module's own generated alias such as `#mdc-highlighter` included) is declared as `any`, or as `string | number | symbol` for a key type. Annotate such exports with a type that refers to it by name (a component's props type, or a type imported from the alias), so it resolves against the consumer's `.nuxt`:

```ts
import type { ComputedRef } from 'vue'
import { computed } from 'vue'
import theme from '#build/ui/button'
import type { ButtonProps } from '../components/Button.vue'

// before: inferred through `theme`, declared as `ComputedRef<any>`
export function useButtonSize(props: ButtonProps) {
  return computed(() => props.size ?? theme.defaultVariants.size)
}

// after: `ButtonProps['size']` is kept by name and resolves against the consumer's `.nuxt`
export function useButtonSize(props: ButtonProps): ComputedRef<ButtonProps['size']> {
  return computed(() => props.size ?? theme.defaultVariants.size)
}
```

Routes the module registers with `addServerHandler` are typed from the module's own `.nuxt` (see [Module tsconfig](#module-tsconfig)), so a composable that returns a `useFetch` or `$fetch` result for one of them is declared with the handler's response type. The response of any other route (one the playground or the consuming app defines) is typed `unknown`. Type those calls, or annotate the export, to publish a precise type:

```ts
import type { AsyncData, NuxtError } from 'nuxt/app'

export const useItems = () => useFetch<Item[]>('/api/items')

export const useItemsAnnotated = (): AsyncData<Item[] | undefined, NuxtError | undefined> => useFetch('/api/items')

export const fetchItems = () => $fetch<Item[]>('/api/items')
```

### Isolated declarations

With `isolatedDeclarations: true` in `tsconfig.json`, the module entry's declarations come from oxc, which is faster than TypeScript but requires every export to have an explicit type. Write the module entry as:

```ts
import type { NuxtModule } from '@nuxt/schema'

const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({ /* ... */ })

export default module
```

Without `isolatedDeclarations`, the build is slower and prints a reminder once per run outside CI. Either setting works.

## Type checking build.config.ts

`unbuild` is no longer in the module's `node_modules`, so a `build.config.ts` that still imports from it fails the module's own type check with TS2307. Either change the import as shown under [Build configuration](#build-configuration), or exclude the file in `tsconfig.json`:

```json
{
  "exclude": ["build.config.ts"]
}
```

## Runtime stylesheets

Stylesheets under `src/runtime` are processed with lightningcss instead of postcss:

- `.css` files are kept one to one: nesting is flattened, vendor prefixes are added for the project's browserslist targets, and the output is minified. `@import` statements are kept as written.
- `.scss` and `.sass` files are compiled with the module's own `sass` or `sass-embedded`, written as `.css` and not minified. Partials (`_name.scss`) are not emitted. Install one of the two compilers when the runtime contains Sass:

  ```bash
  pnpm add -D sass
  ```

- An import of a compiled Sass file in a runtime script points at the emitted file: `import './x.scss'` becomes `import './x.css'`. Other stylesheet imports are kept as written.
- Postcss plugins and other postcss configuration are not applied. Move any such processing into the Nuxt app, or pre-process the stylesheets before the build.

## Runtime output

Each file under `src/runtime` is still emitted under `dist/runtime` with its name intact, scripts as `.js` with a `.d.ts`, `.vue` files as `.vue` with `.vue.d.ts`. Check these differences when a runtime file does not behave as before:

- Relative imports get the emitted extension (`../utils/merge` becomes `../utils/merge.js`). Non-relative specifiers (`#imports`, `#build/*`, dependencies) are kept as written.
- Imports used only as types are removed from the JavaScript output.
- A relative import of a file outside `src/runtime` is emitted where the import points (`src/shared/x.ts` becomes `dist/shared/x.js`), or under `dist/_external/` when that would leave `dist` or collide with another output. Files that are used as types only get a `.d.ts`.
- The module's own package name and `#` subpath imports are never bundled into `module.mjs`.

## Output directory

The build empties `--outDir` (`dist` by default) before writing to it, so it must be a directory inside the module. An `--outDir` of `.`, or of a directory containing the module, is refused.

## Module tsconfig

Declarations are generated with the module's own `.nuxt`, which `nuxt-module-build prepare` writes from a Nuxt instance that runs the module alone. Extend it from the module's `tsconfig.json`, and leave the playground to its own `tsconfig.json`:

```json
{
  "extends": "./.nuxt/tsconfig.json",
  "exclude": ["dist", "node_modules", "playground"]
}
```

When the tsconfig the module falls under extends or references a playground's `.nuxt/tsconfig.json` instead (its own, or a monorepo root's such as `../../tsconfig.json`), the build generates declarations with `./.nuxt/tsconfig.json` plus that tsconfig's own `compilerOptions` (`types` and `paths` included, apart from paths into the playground's `.nuxt`), and prints a note saying so. In a monorepo, give the module a `tsconfig.json` of its own as above, and move any `compilerOptions.types` the module relies on (`"types": ["youtube"]` for a global namespace, for example) into it, so they apply to the module's own type check as well as to the build.

The declaration program starts from the module's own files only: whatever the tsconfig includes outside the module root (a workspace, with `typescript.includeWorkspace`), or under its `playground*`, `docs`, `test`, `tests`, `fixtures`, `example` or `examples` directories, is left out, so their routes and type augmentations do not end up in `dist`. Files the module's sources import are still followed wherever they are.

## Preparing .nuxt

Declarations are generated against `.nuxt/tsconfig.json`, so `nuxt-module-build build` runs `nuxt-module-build prepare` first when `.nuxt` is missing. Keep `prepare` in the module's `dev:prepare` script so the build does not need to:

```json
{
  "scripts": {
    "dev:prepare": "nuxt-module-build build --stub && nuxt-module-build prepare && nuxi prepare playground",
    "prepack": "nuxt-module-build build"
  }
}
```

## Removed dependencies

`unbuild`, `mkdist`, `jiti`, `defu` and `magic-regexp` are no longer installed with `@nuxt/module-builder`. If the module imports any of them in its own code, add it to its own dependencies.

Remove `unbuild` from the module's `devDependencies`, and `mkdist` and `jiti` too when they were only there for the builder:

```bash
pnpm remove unbuild
```

## Checklist

Steps for upgrading a module, in order. Each one is mechanical until the build runs. Use the module's own package manager where `pnpm` is written.

1. Use Node 22.18+ or 24.11+ locally and in CI.
2. `pnpm add -D @nuxt/module-builder@^2.0.0 tsdown@^0.23.7`, then `pnpm remove unbuild` (and `mkdist`, `jiti` if they were only there for the builder). Do this before step 3.
3. In `build.config.ts`, change `from 'unbuild'` to `from '@nuxt/module-builder'`. Move `entries` to `package.json` `build.entries`, directory entries (`{ "input": "src/x/", "outDir": "dist/x" }`) included; delete the file if nothing else is left. Rename a `package.json` `unbuild` field to `build`.
4. In `package.json`, replace `.d.ts` with `.d.mts` for `types.d.ts` and `module.d.ts`, replace `module.cjs` with `module.mjs`, remove `.cjs` entries and the top-level `types` field. Give every `typesVersions` path its full file name (`./dist/util.d.mts`, not `dist/util`).
5. Add `"erasableSyntaxOnly": true` to `tsconfig.json` and rewrite any `enum`, `namespace`, parameter property or `<T>value` assertion the type check reports.
6. If the runtime contains `.scss` or `.sass`, `pnpm add -D sass`.
7. Run `nuxt-module-build prepare` and `nuxt-module-build build`. Fix what it reports: remove each unsupported build option, annotate each export in a portability error, then build again until it passes.
8. Run the module's own type check (for example `nuxt typecheck` or `vue-tsc --noEmit`). Fix what it reports; a build warning about type errors that the type check does not reproduce can be ignored. Annotate exports whose type is inferred through a `#build/*` alias, or `dist` declares them as `any`.
9. Run `pnpm dlx publint`, then `pnpm pack` and `pnpm dlx @arethetypeswrong/cli <name>-<version>.tgz` (`attw --pack .` only works with npm; `npm pack` fails on packages with `devEngines`). Fix any path they report.
10. Run the module's tests and the playground against `dist`.
