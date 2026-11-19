# Contributing

## Setup

`package.json` pins Node and pnpm in `devEngines`, and pnpm downloads them when they are missing.

```bash
pnpm install
pnpm dev:prepare
```

| Script | What it runs |
|---|---|
| `pnpm build` | `tsdown`, building this package into `dist` |
| `pnpm test` | the vitest suite (`pnpm vitest run` for one pass) |
| `pnpm test:types` | `vue-tsc` over the package and the example |
| `pnpm test:knip` | unused files, exports and dependencies |
| `pnpm test:pack` | packs the example and checks it with attw and publint |
| `pnpm lint` | ESLint |
| `pnpm nuxt-module-build` | the CLI from source, for example `pnpm nuxt-module-build build ./example` |

Pages in [`docs/`](./docs) are published on [nuxt.com](https://nuxt.com), so links between them use nuxt.com paths. Build messages link to headings of [`docs/upgrade-v2.md`](./docs/upgrade-v2.md) (see [Diagnostics](#diagnostics)). A unit test checks that every linked heading exists.

## Architecture

The package has three entry points:

- **`src/cli.ts`** is the `nuxt-module-build` binary, also run as `nuxt build-module`. It has two subcommands, `build` and `prepare`.
- **`src/tsdown/index.ts`** exports `builder()`, the tsdown plugin that builds a module. This is how modules build: `tsdown` with `plugins: [builder()]`.
- **`src/index.ts`** exports `build`, `prepare` and the unbuild-compatible `defineBuildConfig`.

### Layout

| Directory | Contents |
|---|---|
| `src/commands/` | The CLI subcommands, plus `config-file.ts`, which finds the module's tsdown config and reads the `builder()` options from it. |
| `src/tsdown/` | The `builder()` plugin. `plugin.ts` creates it, and `setup.ts` turns the tsdown config into a build. It adds the plugins, hooks into tsdown's lifecycle, and handles watch mode. `externals.ts`, `unchanged.ts` and `report.ts` are the plugins and helpers that `setup.ts` uses. `build.ts` runs tsdown for `nuxt-module-build build`. |
| `src/build/` | The build itself, independent of tsdown's plugin API:<br>`options.ts` resolves `builder()` options.<br>`build.ts` resolves a `BuildPlan` and runs the steps before and after the bundle.<br>`loader.ts` imports module code and checks that Node can load it.<br>`package.ts` holds the `package.json` checks.<br>`types.ts` and `module-declarations.ts` write `types.d.mts` and the declarations `prepare` generates.<br>`aliases.ts` rewrites `#app` in declarations.<br>`directives.ts` wraps the oxc transform of runtime files so that TypeScript directive comments are left out.<br>`unchecked.ts` finds the TypeScript files that no tsconfig the module references includes, for `prepare`'s note. |
| `src/transpile/` | `transpileDir()`, the internal rolldown plugin that transpiles a directory file by file. It transforms scripts with oxc and `.vue` files with `vue.ts`, compiles stylesheets with `stylesheets.ts`, emits declarations with `declarations.ts`, rewrites import specifiers with `specifiers.ts`, and resolves the tsconfig of each file with `tsconfig.ts`. It imports nothing outside the directory but `src/utils.ts`, so it can be extracted later. |
| `src/legacy/` | Compatibility with v1 and unbuild (see [Legacy code](#legacy-code)). |
| `src/diagnostics.ts` | The codes of every error and warning the builder reports (see [Diagnostics](#diagnostics)). |
| `src/utils.ts` | Path, file and regex helpers shared across directories, and `logger`, which prints diagnostics outside a tsdown build. |

### `tsdown` with `builder()`

`builder()` acts in tsdown's `tsdownConfig` hook. `setupBuilder` then:

1. Refuses tsdown options that `builder()` sets itself, resolves the module root (following symlinks) and the output directory, and checks the published `package.json` paths.
2. Resolves the `builder()` options into a `ModuleConfig` (`src/build/options.ts`). When `.nuxt` is missing, it runs `prepare` first.
3. Resolves a `BuildPlan` (`resolveBuild` in `src/build/build.ts`), with these parts:
   - the bundled entries (`src/module` and `entries`);
   - the transpiled directories (`src/runtime` and directory entries);
   - the tsconfigs for declarations;
   - the module's self-reference paths;
   - a cache key for `.vue` declarations.
4. Sets `entry`, `format`, `dts`, `clean` and `deps.neverBundle`. Adds `runtimeExternals` (bundled code imports runtime files from `dist` instead of inlining them), the declaration externals, replacements, and one `transpileDir()` per directory.

Then, once per build:

- **`build:prepare`** runs `prepareBuild`:
  - the `build:before` hook;
  - the check that module code loads with Node;
  - emptying the output directory;
  - the derived tsconfig that declaration generation reads.
- **During the bundle**, the bundled entries and each `transpileDir()` emit their files.
- **After writing**, `finishBuild` does the rest. Any failure removes the output directory, except in watch mode.
  - Imports the built `module.mjs` to write `module.json`.
  - Writes `types.d.mts`.
  - Rewrites `#app` in declarations.
  - Checks the package `imports` that the output uses.
  - Runs the `build:done` hook.

In watch mode the output directory is kept, unchanged files aren't rewritten (`unchanged.ts`), and files a rebuild no longer emits are removed. Each `transpileDir()` passes one declaration session to the `.vue` declaration program of every rebuild, so unchanged sources aren't parsed again, and drops it when the watcher closes.

### `nuxt-module-build build`

`src/tsdown/build.ts` runs tsdown programmatically. With a tsdown config in the module root, it builds with that config and fails unless it uses `builder()`. Without one, it builds with `createBuilder()` and `loadLegacyModuleConfig`. That reads `build.config.*` or the `build` field of `package.json`, so a v1 module builds without a tsdown config.

### `nuxt-module-build prepare`

`src/commands/prepare.ts` does the following:

1. Loads the same options as a build.
2. Checks that module code loads with Node, then imports `src/module.ts` with `importModule`.
3. Runs `nuxt prepare` on the module root with that module installed.

That writes `.nuxt`, including:

- the tsconfigs of each context;
- `.nuxt/module-builder/types.d.mts`, which source exports point at;
- the declarations that resolve the module's own package name inside its type checks.

With a root tsconfig that has `references`, it then lists the module's TypeScript files that none of the referenced projects include, once per process and outside CI.

### Module code loads with Node

Nuxt 5, and a playground that loads the module from its sources, import `src/module.ts` with Node as written. Node strips types and resolves imports exactly as they are written. `findModuleCodeIssues` in `src/build/loader.ts` reports each import and each piece of syntax that breaks this, with its file, line, column and fix. `build`, `tsdown` and `prepare` all stop on these findings. Keep this check strict: code that passes it has to run under Node.

### Legacy code

`src/legacy/` holds what only v1 and unbuild users need:

- `build-config.ts` reads and translates `build.config.*` and the `build`/`unbuild` fields of `package.json`, and emulates the unbuild hooks.
- `define.ts` contains `defineBuildConfig` and its types.
- `package-paths.ts` explains v1 `package.json` paths such as `module.cjs`.

Core code doesn't import legacy types. The call sites are:

- `src/index.ts`
- `src/tsdown/build.ts`
- `src/commands/prepare.ts`
- `src/build/options.ts`
- `src/build/package.ts`

Their tests live in `test/legacy.spec.ts`. To drop unbuild compatibility, delete the directory and that spec, then fix the call sites.

### Diagnostics

Errors and warnings that a module author can act on are [nostics](https://www.npmjs.com/package/nostics) diagnostics, defined in `src/diagnostics.ts`. Each has a code: `NUXT_MB_`, then `B` (build), `C` (config) or `D` (v1 and unbuild compatibility), then four digits. Codes are grouped by hundreds within each area, and a published code is never renamed or reused.

There are two catalogs:

- `errors` for diagnostics that are thrown, as in `throw errors.NUXT_MB_C0012({ label, path })`. Creating one prints nothing. `tsdown` and rolldown print the stack of an error, so a diagnostic's stack is its first line followed by the `fix` and docs lines, without frames. rolldown wraps an error thrown from a plugin hook in a build error with its own frames, so `setupBuilder` unwraps a build error made of one diagnostic before tsdown prints it, with the stack of its `cause` after it. `nuxt-module-build` prints a thrown diagnostic with `formatDiagnostic` instead, followed by its `cause`.
- `warnings` for diagnostics that are printed when created, as warnings, or as info or errors when the call passes `{ method }`.

During a build, diagnostics are printed with tsdown's logger (`useBuildLogger()`), so the build's `logLevel`, `failOnWarn` and `suppressWarnings` apply to them. `setupBuilder` hands it tsdown's global logger, then the logger of the resolved config. Outside a build, as in `nuxt-module-build prepare`, they are printed with `logger` from `src/utils.ts`. tsdown is a peer dependency, so `src/diagnostics.ts` only imports its types.

To add one, add an entry to `errorCodes` or `warningCodes` with the next free number in its group:

- `why` says what is wrong and becomes the message. `fix` says what to do. Neither repeats the other.
- `docs` is the `#anchor` of the heading of `docs/upgrade-v2.md` that explains it, or `false`. The printed link points at the guide at the release tag of the version that prints it, `GUIDE_URL`.
- The call passes `sources`: the absolute path of every file that the `why` or `fix` names, with `:line:column` when it names a position. In a terminal, each file that exists is linked where the `why` or `fix` names it, by the end of its path. URLs in the text and the docs link are linked as well.
- The tsconfig sets `isolatedDeclarations`, so `why` and `fix` are string literals or functions with a `: string` return type, and `docs` is a string literal.

Tests assert the code, such as `diagnostic('NUXT_MB_C0012')` or `reported('NUXT_MB_C0201')` from `test/utils.ts`, and the values that matter, rather than the message.

Errors that only the builder handles, such as `DeclarationError`, and those of `src/transpile/`, which imports nothing outside its directory, are plain errors.

## Tests

| Spec | Surface |
|---|---|
| `test/cli.spec.ts` | `nuxt-module-build build` and `prepare` |
| `test/builder.spec.ts` | `tsdown` with `builder()`, and tsconfig `references` |
| `test/watch.spec.ts` | `tsdown --watch` |
| `test/transpile-dir.spec.ts` | `transpileDir()` on its own |
| `test/legacy.spec.ts` | `build.config.*`, the `build` field, `defineBuildConfig` |
| `test/unit.spec.ts` | pure helpers |

Each e2e spec builds its fixtures in one `beforeAll`, in parallel, and its `it` blocks only read the results:

- `fixture()` in `test/utils.ts` copies `example/` (or another fixture) into a gitignored `.temp-*` directory, with files, `package.json` fields and tsconfig `paths` changed.
- `cli()`, `tsdown()` and `run()` start processes, and the number running at once is capped at one per CPU.

Add a case to an existing fixture when it doesn't conflict with that fixture's other cases, and create a new fixture only when it does. Name tests `it('should ...')`.

Coverage of the CLI processes:

```bash
NODE_V8_COVERAGE=/tmp/cov pnpm vitest run
pnpm dlx c8@10 report --temp-directory /tmp/cov --include 'src/**' --reporter text --all --src .
```
