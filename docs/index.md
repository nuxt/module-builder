---
title: Module Builder
description: Build and publish Nuxt modules with `@nuxt/module-builder`.
navigation:
  title: Getting Started
---

`@nuxt/module-builder` builds a Nuxt module for publishing to npm. It provides a [tsdown](https://tsdown.dev) plugin, `builder()`, that bundles your module entry and transpiles your runtime directory file by file. It also generates type declarations against your module's own `.nuxt`, and writes the types that give `nuxt.config` autocompletion for your module's options.

`@nuxt/module-builder` works with the layout of the [module starter](https://github.com/nuxt/starter/tree/module) and needs no options for it. To learn how to write the module itself, such as its definition, its hooks, and the `@nuxt/kit` utilities, read the [Module Author Guide](/docs/guide/modules).

## Requirements

To build a module, you need:

- Node `^22.18.0 || ^24.11.0 || >=26.0.0`.
- `tsdown` and `typescript` (`^5.9.3 || ^6.0.0`), which are peer dependencies of `@nuxt/module-builder`.
- `nuxt`, which provides the `@nuxt/cli` that `nuxt-module-build prepare` runs.

An app needs Nuxt 3 or later to use a module that `@nuxt/module-builder` builds. The module entry is compiled for the lowest Node version in your module's `engines.node` field. Without that field, its syntax is kept as written.

::note
Nuxt 3 has reached end of life, so these docs describe Nuxt 4 and later. They don't cover the places where Nuxt 3 behaves differently, such as type-checking all of a module's runtime files in a single context.
::

## Quick start

Create a module from the starter:

```bash [Terminal]
pnpm create nuxt -t module my-module
```

The starter uses [source exports](/docs/api/module-builder/develop-and-publish#source-exports) with pnpm, so `create nuxt` installs its dependencies with pnpm, whichever package manager runs it. pnpm has to be installed.

Then start the playground:

```bash [Terminal]
cd my-module
pnpm dev
```

`dev` runs `nuxt-module-build prepare`, which generates the `.nuxt` that types your module, and then `nuxt dev playground`. To generate the types of the module and the playground without starting the playground, such as before a type check, run `pnpm dev:prepare`. To find out what each script does, or to develop with another package manager, read [Develop and Publish](/docs/api/module-builder/develop-and-publish).

## Manual installation

To add `@nuxt/module-builder` to an existing module, follow these steps:

1. Install `@nuxt/module-builder` and its peer dependencies:

   ```bash
   pnpm add -D --ignore-workspace-root-check @nuxt/module-builder@^2.0.0-alpha.0 tsdown@^0.23.7 typescript nuxt
   ```

   `--ignore-workspace-root-check` lets `pnpm add` install at the root of a pnpm workspace, and has no effect in a single package. If pnpm's `minimumReleaseAge` or Yarn's `npmMinimalAgeGate` rejects a recent release, see [Install v2 and tsdown](/docs/api/module-builder/upgrade-v2#step-1-install-v2-and-tsdown).

2. Create a `tsdown.config.ts` in the module root that uses the `builder()` plugin:

   ```ts [tsdown.config.ts]
   import { builder } from '@nuxt/module-builder/tsdown'
   import { defineConfig } from 'tsdown'

   export default defineConfig({
     plugins: [builder()],
   })
   ```

3. Add the scripts that prepare your module for development and build it before publishing:

   ```json [package.json]
   {
     "scripts": {
       "dev": "nuxt-module-build prepare && nuxt dev playground",
       "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground",
       "prepack": "tsdown"
     }
   }
   ```

4. Point the `exports` of `package.json` at your module, as described in [Project Structure](/docs/api/module-builder/project-structure#packagejson).
5. Create a `tsconfig.json` that references the tsconfigs in `.nuxt`, as described in [TypeScript](/docs/api/module-builder/typescript).

The `dev:prepare` script in step 3 is for a module that you publish with pnpm or Yarn 4. If you publish with npm, Yarn 3 or earlier, or bun, add `tsdown` before `nuxt prepare playground`. [Develop and Publish](/docs/api/module-builder/develop-and-publish#preparing-a-checkout) explains the difference.

## Next steps

- [Project Structure](/docs/api/module-builder/project-structure): the files that `@nuxt/module-builder` reads.
- [Commands](/docs/api/module-builder/commands): `tsdown`, `nuxt-module-build build`, and `nuxt-module-build prepare`.
- [Develop and Publish](/docs/api/module-builder/develop-and-publish): the two development setups, the playground, and releases.
- [Configuration](/docs/api/module-builder/configuration): `tsdown.config.ts`, extra entries, and externals.
- [TypeScript](/docs/api/module-builder/typescript): your module's `tsconfig.json`, its declarations, and the rules for module code.
- [Build Output](/docs/api/module-builder/output): the files in `dist`, and the size report.
- [Exports](/docs/api/module-builder/exports): subpath exports, including runtime components.
- [Upgrading to v2](/docs/api/module-builder/upgrade-v2): moving a module from v1.
