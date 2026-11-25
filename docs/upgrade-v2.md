---
title: Upgrading to v2
description: Move a Nuxt module from v1 to v2 of `@nuxt/module-builder`, which builds with tsdown.
---

This guide moves a Nuxt module from v1 to v2 of `@nuxt/module-builder`. Follow the steps in order. Each step that doesn't apply to every module starts with its condition, so you can skip it. If you followed a link from a build message, see [Build messages](#build-messages).

## What changes in v2

v2 builds your module with [tsdown](https://tsdown.dev) instead of unbuild. The layout, with `src/module.ts` and `src/runtime/`, stays the same, and so does `dist`. Most other changes follow from one fact: Nuxt 5 loads a module's sources with Node as written.

- A `tsdown.config.ts` with the `builder()` plugin replaces `build.config.ts`, and `tsdown` replaces `nuxt-module-build build`.
- `src/module.ts` and the files that it imports have to load with Node, so relative imports carry their extension.
- Stub builds are removed. With pnpm or Yarn 4, `package.json` points at your sources while you develop. With other package managers, `tsdown --watch` rebuilds `dist`.
- The output is ES modules only, with `.d.mts` declarations for the module entry and no `module.cjs`.
- `nuxt-module-build prepare` generates a tsconfig for each part of the module, and `vue-tsc -b` checks each part with the types it has in an app.
- The build doesn't type check, so your own type check runs as a separate step.

## Before you start

- Use Node `^22.18.0 || ^24.11.0 || >=26.0.0`, locally and in CI.
- Find out which package manager publishes your module. Step 6 depends on it.
- The steps use `pnpm`. Use your module's own package manager instead. Run commands with its `exec`, such as `pnpm exec tsdown`, and scripts with its `run`, such as `pnpm run dev:prepare`.
- The builder's command is `nuxt-module-build`, with the alias `nuxt-build-module`. The Nuxt CLI also runs it as `nuxt build-module` and `nuxt module-build`, or the same with `nuxi`. The steps write `nuxt-module-build`, and apply to every name.

## Steps

### Step 1: Install v2 and `tsdown`

Install v2 together with `tsdown`, which is a peer dependency:

```bash
pnpm add -D --ignore-workspace-root-check @nuxt/module-builder@^2.0.0-alpha.0 tsdown@^0.23.7
```

- `--ignore-workspace-root-check` lets `pnpm add` install at the root of a pnpm workspace, and has no effect elsewhere. Yarn 1 takes `-W` instead. Other package managers need no flag.
- If your module is a package of a monorepo, such as `packages/my-module`, run the command in the module's directory. Or add both packages to the catalog that the module's `package.json` uses.
- If pnpm's `minimumReleaseAge` fails the install with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, add the `<package>@<version>` that the error names to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Then install again. Without an error, the same setting can install an older v2 release than the latest one.
- If Yarn's `npmMinimalAgeGate` fails the install with `YN0016`, add the package that the error names to `npmPreapprovedPackages` in `.yarnrc.yml`. Then install again.

Then change the other dependencies:

- If `unbuild` is in `devDependencies`, run `pnpm remove unbuild`. Remove `mkdist` and `jiti` too, if only the builder used them.
- If your module's own code imports `unbuild`, `mkdist`, `jiti`, `defu`, or `magic-regexp`, add that package to its dependencies. v2 doesn't install them any more.
- If `src/runtime` contains `.scss` or `.sass` files, run `pnpm add -D --ignore-workspace-root-check sass`. v2 compiles them with your module's own `sass` or `sass-embedded`.

### Step 2: Move the build options into `tsdown.config.ts`

Create a `tsdown.config.ts` in the module root. A module without build options needs only the `builder()` plugin:

```ts [tsdown.config.ts]
import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [builder()],
})
```

If your module has a `build.config.ts`, or a `build` or `unbuild` field in `package.json`, move their options into this config:

| v1 option | In `tsdown.config.ts` |
| --- | --- |
| `entries` | `builder({ entries })`, in the same shapes |
| `externals` | `builder({ externals })` |
| `replace` and `rollup.replace` | `builder({ replace })` |
| `sourcemap` | `sourcemap` |
| `hooks['build:before']` | tsdown's `hooks['build:prepare']`, where `ctx.options.cwd` is the module root |
| `hooks['build:done']` | tsdown's `hooks['build:done']` |
| `hooks['rollup:done']` | a plugin that [emits the extra files](./4.configuration.md#extra-files-in-the-output), or `package.json` paths that point at the files the build emits |
| `rollup.inlineDependencies` | a list: tsdown's `deps.onlyBundle`. `true`: `deps.onlyBundle: false`. `false`: nothing, drop it |
| `hooks['mkdist:*']`, `declaration`, `failOnWarn`, `name`, and `parallel` | nothing: drop them |
| any other option | see [Unsupported build options](#unsupported-build-options) |

For example, this `build.config.ts`:

```ts [build.config.ts]
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['./src/utils'],
  externals: ['shiki'],
  hooks: {
    'build:before': ctx => generateTypes(ctx.options.rootDir),
  },
})
```

becomes this `tsdown.config.ts`:

```ts [tsdown.config.ts]
import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  hooks: {
    'build:prepare': ctx => generateTypes(ctx.options.cwd),
  },
  plugins: [
    builder({
      entries: ['./src/utils'],
      externals: ['shiki'],
    }),
  ],
})
```

- If both `build.config.ts` and a field of `package.json` hold options, move the options of both. List each external once.
- The build never bundles the packages in `dependencies`, `peerDependencies`, and `optionalDependencies`, their subpaths, Node builtins, `@nuxt/kit`, `@nuxt/schema`, `nuxt`, `vue`, `#app`, `#build/*`, and `#imports`. Drop the externals that are among these, and those that no bundled entry imports. Keep the rest in `builder({ externals })`.
- The build fails when it bundles any other package from `node_modules`, `devDependencies` included. See [Bundled packages](#bundled-packages).
- `src/module` is always built, so you can leave it out of `entries`. Drop `addRelativeDeclarationExtensions` from directory entries.
- Relative imports in `tsdown.config.ts` carry their extension, because `prepare` loads the file with Node.

Then delete `build.config.ts`, and remove the `build` or `unbuild` field. With a `tsdown.config.ts`, the build fails while either of them is still there. [Configuration](./4.configuration.md) describes every option.

### Step 3: Update the paths in `package.json`

v2 emits ES modules only, and writes the module entry's declarations as `.d.mts` files. In `exports`, `main`, `types`, and `typesVersions`:

- Replace `.d.ts` with `.d.mts` in the paths of `types.d.ts` and `module.d.ts`.
- Replace `module.cjs` with `module.mjs`, and remove the other `.cjs` paths and `require` conditions.

```json [package.json]
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

Then decide whether your module supports `node10` consumers: projects that import it and type check with `"moduleResolution": "node"` or `"node10"`, or with `"module": "commonjs"` and no `moduleResolution`. They read `types` and `typesVersions` instead of `exports`. An app on Nuxt 4 isn't one.

- If your module doesn't support them, remove the top-level `types` field and `typesVersions`. Subpath exports then don't resolve under `node10`, which step 10 leaves out of its check.
- If it does, set `types` to `./dist/types.d.mts`. Write every `typesVersions` path with its full file name, such as `./dist/utils.d.mts` rather than `dist/utils`, because `node10` doesn't look for `.d.mts` files. A wildcard such as `"*": ["./dist/*"]` also maps the path in `types`, so check the root import under `node10` too.

After each build, a warning lists any other path in these fields that the build didn't produce. Add the entry that produces it in step 2, or remove the path.

### Step 4: Make module code load with Node

`nuxt-module-build prepare` and the build load module code with Node, as Nuxt 5 does. Module code is `src/module.ts`, every file that it imports by value (runtime files included), and `tsdown.config.ts`. In these files:

- Add the file's extension to every relative import, type-only imports included: `./utils` becomes `./utils.ts`, and `./dir` becomes `./dir/index.ts`.
- Replace imports through tsconfig `paths` aliases with relative imports, or with entries in the `imports` field of `package.json`.
- Rewrite `enum`, `namespace` with values, parameter properties, `<Type>value` assertions, `import x = require()`, `export =`, and decorators.
- Import JSON with an import attribute, and read properties from its default export.
- Move values that module code imports from `.vue`, `.tsx`, or `.jsx` files into `.ts` files.
- Move code that needs values from `#app`, `#imports`, or `#build/*` into a runtime file that the module adds, such as a plugin. Type imports from them can stay.

```ts [src/module.ts]
// before
import { version } from '../package.json'
import { resolveOptions } from './options'
import { addComponents } from './components'

// after
import pkg from '../package.json' with { type: 'json' }
import { resolveOptions } from './options.ts'
import { addComponents } from './components/index.ts'
```

[Module code](./5.typescript.md#module-code) shows how to rewrite each of these.

Before you run `prepare`:

- If module code imports files that a build hook generates, commit them, or generate them in `dev:prepare` before `nuxt-module-build prepare`. tsdown's hooks don't run for `prepare`.
- If your module is in a monorepo and has no `tsconfig.json` of its own, create the `tsconfig.json` of step 5 now. Otherwise, `prepare` reads the repository root's tsconfig, which can extend a `.nuxt` that doesn't exist yet.

Then run `pnpm exec nuxt-module-build prepare`. Until module code loads with Node, it lists every problem with its file, line, and fix, and doesn't generate `.nuxt`. Fix them all, and run it again to generate `.nuxt`.

### Step 5: Switch to the module's own tsconfigs

`prepare` generates a tsconfig in `.nuxt` for each part of the module. Change `tsconfig.json` to reference them, as follows. Remove its `extends` and `include`, and keep its `compilerOptions` and `exclude`:

```json [tsconfig.json]
{
  "references": [
    { "path": "./.nuxt/tsconfig.node.json" },
    { "path": "./.nuxt/tsconfig.app.json" },
    { "path": "./.nuxt/tsconfig.server.json" },
    { "path": "./.nuxt/tsconfig.shared.json" }
  ],
  "files": [],
  "exclude": ["dist", "node_modules", "playground"]
}
```

`prepare` sets `erasableSyntaxOnly` in the generated tsconfig for module code, so the type check reports the syntax that Node can't run. Then adjust the setup to your module:

- `prepare` copies the `compilerOptions` of `tsconfig.json` into every part. Move `types` that only tests use, such as `"vitest/globals"`, into a `tsconfig.test.json` (see below). For options of module code only, see [Options of one part](./5.typescript.md#options-of-one-part).
- `prepare` doesn't copy `paths` or `baseUrl`. Move each alias from `paths` into the `imports` field of `package.json`.
- The generated tsconfigs cover `src` and the module's `.d.ts` files. Move a `.d.ts` that is in an excluded directory, such as `test/`, into `src`.
- Tests outside `test/nuxt`, and TypeScript config files in the module root such as `tsdown.config.ts`, are in no part. To type check them, add a [`tsconfig.test.json`](./5.typescript.md#tests-and-config-files) to `references`. Leave out of its `include` what your old `exclude` left out, such as `test`.
- If your module is in a monorepo, put `tsconfig.json` in the module's directory. Copy into its `compilerOptions` the entries of the repository root's `types` that `src` relies on.

Then change the type check:

- If `vue-tsc` isn't in `devDependencies`, run `pnpm add -D --ignore-workspace-root-check vue-tsc`.
- In the type-check script, replace the module's own `vue-tsc --noEmit`, `tsc --noEmit`, or `nuxt typecheck` without a directory, with `vue-tsc -b --noEmit`. Keep the rest of the script: `vue-tsc --noEmit && nuxt typecheck playground` becomes `vue-tsc -b --noEmit && nuxt typecheck playground`.
- If your module has no type-check script, add `"test:types": "vue-tsc -b --noEmit"`.

Run `pnpm exec nuxt-module-build prepare`, then `pnpm exec vue-tsc -b --noEmit`. Don't run the type-check script yet, as it can still run a stub build that step 7 removes. [Errors from checking each part](./5.typescript.md#errors-from-checking-each-part) lists the errors that this can report, with their fixes.

To keep a single `tsconfig.json` that extends `./.nuxt/tsconfig.json` instead, see [Extending .nuxt/tsconfig.json](./5.typescript.md#extending-nuxttsconfigjson).

### Step 6: Choose how the playground loads the module

The playground installs the module by its package name, so it loads whatever `package.json` points at. In v1, a stub build made `dist` load your sources. In v2, the package manager that publishes the module decides the setup.

If you publish with pnpm or Yarn 4, point `exports`, `imports`, and `main` at your sources, and the same fields in `publishConfig` at `dist`. Both publish the fields of `publishConfig` in place of the top-level ones:

```json [package.json]
{
  "exports": {
    ".": { "types": "./.nuxt/module-builder/types.d.mts", "import": "./src/module.ts" },
    "./utils": { "types": "./src/utils.ts", "import": "./src/utils.ts" }
  },
  "main": "./src/module.ts",
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/types.d.mts", "import": "./dist/module.mjs" },
      "./utils": { "types": "./dist/utils.d.mts", "import": "./dist/utils.mjs" }
    },
    "main": "./dist/module.mjs"
  }
}
```

- `publishConfig.exports` and `publishConfig.imports` replace the top-level fields as a whole, so repeat every subpath and condition.
- The root export's `types` condition points at `.nuxt/module-builder/types.d.mts`, which `prepare` writes. A subpath points at its source.
- If you kept `types` in step 3, move it into `publishConfig`. Keep `typesVersions` at the top level, pointing at `dist`.
- If code outside Nuxt loads a subpath with Node, keep that subpath pointing at `dist`. A Vite plugin for a plain Vite app is one example. Step 4 doesn't check its source. Run `tsdown` before anything loads that subpath, as in step 7.
- Point [code that reaches into `dist`](./3.develop-and-publish.md#code-that-reaches-into-dist) by path, such as a test that imports `../dist/runtime/...`, at `src`.

If you publish with npm, Yarn 3 or earlier, or bun, keep `package.json` pointing at `dist`. Step 7 builds `dist` in `dev:prepare`, and `tsdown --watch` rebuilds it while you develop. [Develop and Publish](./3.develop-and-publish.md#preparing-a-checkout) describes both setups.

If the playground lists the module by name, install the module in `playground/package.json` as [Installing the module in the playground](./3.develop-and-publish.md#installing-the-module-in-the-playground) shows.

### Step 7: Update the scripts

In each script that runs the builder, change only the builder's commands, and keep every other command where it is. That covers `prepack`, `dev:prepare`, and any other script or CI workflow that runs the builder under one of its names:

- `nuxt-module-build build` becomes `tsdown`. `tsdown` takes no module directory, so `nuxt-module-build build .` becomes `tsdown` too. `nuxt-module-build` without a subcommand only prints its usage, so it becomes `tsdown` as well.
- For a module in another directory, run `cd packages/my-module && tsdown`, or keep `nuxt-module-build build packages/my-module`.
- `nuxt-module-build build --stub`: if `package.json` points at your sources, remove it. If it points at `dist`, replace it with `tsdown`.
- `nuxt-module-build prepare --stub` becomes `nuxt-module-build prepare`.
- A script that only ran the stub build, such as `"stub": "nuxt-module-build build --stub ."`, has nothing left to run. Delete it, and remove it from the scripts that run it, such as `pnpm stub &&`.
- In `dev:prepare`, run `nuxt-module-build prepare` first, before the build and every `nuxt prepare`. Add it if it isn't there.
- In `dev`, run `nuxt-module-build prepare` before `nuxt dev playground`. Without `.nuxt`, the playground responds to every request with a 500 error.
- If `package.json` points at `dist`, run `tsdown` in `dev:prepare` before the first `nuxt prepare`. Do the same if a subpath stays at `dist` and the playground or tests load it.
- The build empties `dist` first, so a command that writes into `dist` has to run after `tsdown`.
- If `package.json` points at your sources, run `tsdown` as a command of `prepack` itself, so that the [pack checks](#publishing-source-exports) run. A `prepack` that runs another script, such as `pnpm run build`, isn't checked: move that script's commands into `prepack`.

For example, these v1 scripts also minify a file into `dist` and prepare a docs app:

```json [package.json]
{
  "scripts": {
    "prepack": "nuxt-module-build build && esbuild --minify src/script.js --outfile=dist/script.min.js",
    "dev:prepare": "nuxt-module-build build --stub && nuxt-module-build prepare && nuxt prepare playground && nuxt prepare docs"
  }
}
```

If `package.json` points at your sources, they become:

```json [package.json]
{
  "scripts": {
    "prepack": "tsdown && esbuild --minify src/script.js --outfile=dist/script.min.js",
    "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground && nuxt prepare docs"
  }
}
```

If `package.json` points at `dist`, `dev:prepare` builds `dist` after `prepare` instead: `nuxt-module-build prepare && tsdown && nuxt prepare playground && nuxt prepare docs`.

### Step 8: Build

1. Run `pnpm run dev:prepare`.
2. Run `pnpm exec tsdown`.
3. Fix what the build reports. Each message starts with a code and links to its section in [Build messages](#build-messages). Build again until the build passes.
4. Run `pnpm run prepack` once, so that its other commands run too.

### Step 9: Type check

Run your module's type-check script, and fix what it reports. [Errors from checking each part](./5.typescript.md#errors-from-checking-each-part) lists the errors that it can report.

- The build doesn't type check, so run the script as a step of its own in CI, after `dev:prepare`.
- The build types aliases such as `#build/*` as `any`. Annotate each export whose type is inferred through one, as [Other type errors](./5.typescript.md#other-type-errors) shows. Otherwise, `dist` declares it as `any`.

### Step 10: Check the package

1. Run `pnpm pack`. It writes a tarball, such as `my-module-1.0.0.tgz`.
2. Run `pnpm dlx publint my-module-1.0.0.tgz`.
3. List the imports in its declarations that don't resolve from the package alone. Write the report to a file first, as attw can exit before a pipe reads all of it:

   ```bash
   pnpm dlx @arethetypeswrong/cli my-module-1.0.0.tgz --profile esm-only --format json > attw.json
   jq -r '.analysis.problems[] | select(.kind == "InternalResolutionError") | "\(.resolutionOption) \(.moduleSpecifier) \(.fileName)"' attw.json | sort -u
   ```

   Check that each one is an alias that only a Nuxt app provides, such as `#app`, `#imports`, or `#build/my-module`. Aliases that your module, or a module it installs, adds to the app count too. Fix any other.

4. Run attw with those imports ignored:

   ```bash
   pnpm dlx @arethetypeswrong/cli my-module-1.0.0.tgz --profile esm-only --ignore-rules internal-resolution-error
   ```

5. If you kept `types` and `typesVersions` in step 3, check `node10` resolution as well, with `--ignore-rules cjs-resolves-to-esm internal-resolution-error` and no `--profile`.
6. Fix any path that publint or attw reports.
7. In a fresh Nuxt app, install the tarball:

   ```bash
   pnpm install /path/to/my-module-1.0.0.tgz
   ```

   Add the module to `modules` in `nuxt.config.ts`, then start and build the app. If consumers import from your package directly, use those imports in the app and run its type check.

   If you vendor types, check the affected imports again in a separate TypeScript config with `skipLibCheck: false`. Extend the relevant generated Nuxt config, such as `.nuxt/tsconfig.app.json`, to keep aliases like `#app`. Look for errors in your package's declarations.

[Checking the package](./3.develop-and-publish.md#checking-the-package) explains what attw reports for a module that is correct, and how to run step 4 on every build with tsdown's `attw` option. Finally, run your module's tests and its playground.

## Build messages

Each message that requires a change starts with a code, such as `NUXT_MB_D0001`, and links to the section that explains it. Some link to the step that fixes them.

### tsdown config

`tsdown.config.ts` builds the module with the `builder()` plugin:

- Add `plugins: [builder()]` to the config, as in [step 2](#step-2-move-the-build-options-into-tsdownconfigts). `tsdown` and `nuxt-module-build build` fail with a tsdown config that doesn't use it.
- Call `builder()` in the config that builds the module. One `builder()` plugin that two configs share fails the build, and so does an array with `builder()` in more than one config.
- `builder()` takes `entries`, `externals`, and `replace`. Set every other option on the tsdown config itself.
- `prepare` reads the module in the directory of the tsdown config, so the config can't set `cwd` to another directory.

See [Configuration](./4.configuration.md).

### Options `builder()` sets

`builder()` sets some tsdown options itself, such as `entry`, `format`, `dts`, and `clean`. Remove them from the tsdown config. The message names each one with its replacement: for example, list entries in `builder({ entries })`, and externals in `builder({ externals })` or `deps.neverBundle`.

The build also fails when another plugin changes one of these options, or the file names of the bundled entries through `outputOptions.entryFileNames`. Configure that plugin to leave them unchanged, or remove it. [Options that `builder()` sets](./4.configuration.md#options-that-builder-sets) lists them all.

### Hooks in a tsdown config

`builder()` takes no `hooks`. Use tsdown's own `hooks` in the config: `build:prepare` in place of `build:before`, and `build:done`. To add a file to `dist`, emit it from a plugin. See [Hooks](./4.configuration.md#hooks).

tsdown's hooks and plugins don't run for `nuxt-module-build prepare`, or for a playground that loads your sources. If module code imports generated files, commit them, or generate them in `dev:prepare` before `nuxt-module-build prepare`.

### Bundled packages

The build fails when the bundled entries bundle a package from `node_modules` that `package.json` doesn't list in `dependencies` or `peerDependencies`. For each package that the message names:

- If apps that install the module need it, move it to `dependencies` or `peerDependencies`.
- If bundling it is intended, list it in tsdown's `deps.onlyBundle`. Without a `tsdown.config.ts`, list it in `rollup.inlineDependencies` instead.
- If the app provides it, add it to `builder({ externals })`.

Module Builder keeps imports of installed packages in generated declarations, even when it bundles their JavaScript. If you vendor a dependency, point your public declarations at the types you ship. Check those imports as in [step 10](#step-10-check-the-package).

See [Externals](./4.configuration.md#externals).

### Output directory

The build empties the output directory before it writes to it, and `tsdown --watch` removes the files that it doesn't emit any more. So `outDir` and `--outDir` have to name a directory inside the module, such as `dist`. A directory outside the module, such as `../dist`, or the module root itself, fails the build.

### Stub builds

`nuxt-module-build build --stub` and `nuxt-module-build prepare --stub` are removed.

- With pnpm or Yarn 4, point `package.json` at your sources, as in [step 6](#step-6-choose-how-the-playground-loads-the-module), and remove the stub build from your scripts.
- With npm, Yarn 3 or earlier, or bun, replace the stub build with `tsdown`, after `nuxt-module-build prepare`. Run `tsdown --watch` next to `nuxt dev playground`.

[Step 7](#step-7-update-the-scripts) lists every change to the scripts.

### Preparing `.nuxt`

The build generates declarations with the tsconfigs in `.nuxt`, so it runs `nuxt-module-build prepare` first when `.nuxt` is missing. It does the same when the tsconfigs in `.nuxt` map a package into a directory that no longer exists, as after a dependency update. Run `nuxt-module-build prepare` first in your `dev:prepare` script instead, as in [step 7](#step-7-update-the-scripts), and again after you update dependencies.

The `.nuxt` that the build prepares can leave out the declarations that the module's own type check reads. Run `nuxt-module-build prepare` yourself before `vue-tsc -b --noEmit`.

### Declaration errors

The build generates declarations with TypeScript, using the tsconfig project that includes each file. It fails when a declaration would be missing or wrong:

- An export whose inferred type can't be named (TS2742, TS2883, or TS4023) needs a type annotation. See [Portability errors](#portability-errors).
- If `.nuxt` is out of date, run `nuxt-module-build prepare` and build again.
- A component without a `generic` script setup is declared with the types of `vue`, so the build fails when `vue` doesn't resolve from it. Add `vue` to `devDependencies`, or make the tsconfig that includes the component extend or reference the tsconfigs in `.nuxt`, which map `vue` in `paths`.
- Syntax errors, and files for which no declaration can be emitted, fail the build too.

The build doesn't type check otherwise, so your own type check reports every other type error. See [Declarations](./5.typescript.md#declarations).

### Portability errors

An export whose inferred type refers to a package that your module can't import by name can't be declared. Give each export that the message lists an explicit type annotation. When the value comes from a function that your module imports, annotate it with that function's return type:

```ts
// before
export const handler = defineCachedHandler(...)

// after
export const handler: ReturnType<typeof defineCachedHandler> = defineCachedHandler(...)
```

When `prepare` reports this, as a warning, run `nuxt-module-build prepare` again after the fix. [Errors that fail the build](./5.typescript.md#errors-that-fail-the-build) has more examples.

### Isolated declarations

With `isolatedDeclarations: true` in the tsconfig that includes `src/module.ts`, the build generates the module entry's declarations with oxc. This is faster than TypeScript, but requires an explicit type on every export. TypeScript only accepts `isolatedDeclarations` with `declaration` and without `allowJs`, which the generated tsconfigs set, so set all three in a `tsconfig.module.json` that you reference in place of `./.nuxt/tsconfig.node.json`:

```json [tsconfig.module.json]
{
  "extends": "./.nuxt/tsconfig.node.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./.nuxt/tsconfig.module.tsbuildinfo",
    "allowJs": false,
    "declaration": true,
    "isolatedDeclarations": true
  }
}
```

`vue-tsc -b --noEmit` then reports every export without an explicit type in the files that module code imports, runtime files included, also through `import type`. A `.js` or `.mjs` file that module code imports needs a declaration file next to it, such as `utils.d.mts` for `utils.mjs`. Write the module entry as follows:

```ts [src/module.ts]
import type { NuxtModule } from '@nuxt/schema'

const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({ /* ... */ })

export default module
```

Leaving it off is fine: the build then generates these declarations with TypeScript, alongside the runtime files, and reuses them while their inputs are unchanged. See [`isolatedDeclarations`](./5.typescript.md#isolateddeclarations).

### Publishing source exports

Every build reads the path fields of `package.json`, with `publishConfig` applied. It fails when one of them points at a TypeScript source, or at a file that `files` leaves out. Point the field at `dist`, in `publishConfig` if `package.json` points at your sources. To publish a file other than a TypeScript source as it is, list it in `files`.

When `tsdown` runs as the `prepack` or `prepublishOnly` script, the build also checks the package manager that packs. It has to apply `publishConfig` to each of these fields:

- Pack and publish with pnpm or Yarn 4, as `pnpm publish` or `yarn npm publish`. A script that runs `npm publish` fails, even when `pnpm run` starts it.
- Set each field that points at your sources in `publishConfig`, apart from `typesVersions`, which points at `dist`.

See [Checks on published paths](./3.develop-and-publish.md#checks-on-published-paths) and [Checks when you pack](./3.develop-and-publish.md#checks-when-you-pack).

### Other tsconfig layouts

These messages appear when the module doesn't have the tsconfigs of step 5. Either its tsconfig extends another app's `.nuxt/tsconfig.json`, such as a monorepo root's, or the build reads the nearest tsconfig above the module. Give the module a `tsconfig.json` in its own directory, as in [step 5](#step-5-switch-to-the-modules-own-tsconfigs). If one of the module's own tsconfigs can't be read, fix it, or generate the file it names before you run `prepare`. See [Monorepos](./5.typescript.md#monorepos).

### tsconfig `paths`

The `paths` of a tsconfig replace those of the tsconfig that it extends. A tsconfig of your own that extends one in `.nuxt` and sets `paths` leaves out the entries that Nuxt generates, such as `#app`, `#imports`, and `vue` when it isn't in `devDependencies`. Your type check then doesn't resolve them, and types components as `any` without `vue`. The build generates declarations with the generated entries, and warns.

Remove `paths` from that tsconfig, whether it is `tsconfig.json` extending `./.nuxt/tsconfig.json` or a tsconfig that `tsconfig.json` references in place of a generated one. Replace each of your aliases with a relative import, or with an entry in the `imports` field of `package.json`, as in [No tsconfig `paths` aliases](./5.typescript.md#no-tsconfig-paths-aliases). With source exports, add its `dist` path to `publishConfig.imports`.

### Tests and config files

Outside CI, `nuxt-module-build prepare` lists the TypeScript files that no tsconfig in `references` includes, with the number of files in each directory. `vue-tsc -b` doesn't type check them. These are usually tests outside `test/nuxt`, fixtures, and config files in the module root.

Reference a `tsconfig.test.json` that includes them, as in [Tests and config files](./5.typescript.md#tests-and-config-files), or add them to the `exclude` of `tsconfig.json`.

### `build.config.ts` and the `build` field

`build.config.ts` and the `unbuild` field of `package.json` are deprecated. Without a `tsdown.config.ts`, the build still applies their options. Move them into `tsdown.config.ts`, as in [step 2](#step-2-move-the-build-options-into-tsdownconfigts).

Until then:

- Import `defineBuildConfig` from `@nuxt/module-builder` instead of `unbuild`. v2 doesn't install `unbuild`, so the old import fails the type check with TS2307.
- Rename the `unbuild` field of `package.json` to `build`.

### Unsupported build options

Without a `tsdown.config.ts`, the build reads `build.config.ts` and the `build` field of `package.json`. It fails with a list of every option it can't apply, and the file that each comes from. [Step 2](#step-2-move-the-build-options-into-tsdownconfigts) moves the options that v2 supports into `tsdown.config.ts`. To keep `build.config.ts` for now, remove each listed option instead.

#### Hooks

Only the `build:before`, `rollup:done`, and `build:done` hooks run. `mkdist:*` hooks are ignored with a warning, and every other hook, such as `rollup:options`, fails the build. Remove them.

#### Rollup options

The module entry is bundled with tsdown's defaults for a Node library, so `rollup.*` options fail the build. Remove them. The build applies `rollup.replace` and `rollup.inlineDependencies`, and accepts `rollup.emitCJS: false`, `rollup.cjsBridge: false`, and `rollup.output.exports`.

#### CommonJS output

The build emits ES modules only, so `rollup.emitCJS: true` fails the build. Remove it, and update `package.json` as in [step 3](#step-3-update-the-paths-in-packagejson).

#### mkdist options

Runtime files are transpiled with oxc, one file at a time. The `esbuild`, `pattern`, and `format` options of an entry fail the build, so remove them. The build applies `ext` (`mjs` or `js`), and ignores `declaration` and `addRelativeDeclarationExtensions`. Postcss plugins from `mkdist:entry:options` aren't applied. See [Runtime files](./6.output.md#runtime-files) for how stylesheets are processed.

#### Other options

These options fail the build too:

- `stub` and `stubOptions`. See [Stub builds](#stub-builds).
- `clean: false`. The build empties the output directory before a one-off build.
- `rootDir` or `outDir` set to anything other than the module root and `dist`.
- An array of more than one config. Keep a single config object.
- A config that exports a function. Export the object that it returns.
- Any key that unbuild doesn't define.

## Other changes

These changes need no action in most modules. Check them if a runtime file behaves differently after the upgrade:

- Runtime files are transpiled one at a time with oxc. Type-only imports and TypeScript directive comments are removed. See [Runtime files](./6.output.md#runtime-files).
- `.tsx` and `.jsx` runtime files keep their JSX for the app to compile, unless they run in Nitro or Node. See [JSX](./6.output.md#jsx).
- Runtime stylesheets are processed with lightningcss instead of postcss, without your postcss configuration.
- A relative import of a file outside `src/runtime` emits that file where the import points, or under `dist/_external/`.
