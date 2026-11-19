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

::code-group{sync="pm"}

```bash [npm]
npm create nuxt -- -t module my-module
```

```bash [yarn]
yarn create nuxt -t module my-module
```

```bash [pnpm]
pnpm create nuxt -t module my-module
```

```bash [bun]
bun create nuxt --template=module my-module
```

::

Then install its dependencies and prepare it for development:

```bash
cd my-module
npm install
npm run dev:prepare
```

`dev:prepare` generates the `.nuxt` directories that type your module and its playground. To find out what each step does, read [Develop and Publish](/docs/guide/modules/module-builder/develop-and-publish).

## Manual installation

To add `@nuxt/module-builder` to an existing module, follow these steps:

1. Install `@nuxt/module-builder` and its peer dependencies:

   ```bash
   pnpm add -D @nuxt/module-builder@^2.0.0-alpha.0 tsdown@^0.23.7 typescript nuxt
   ```

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
       "dev": "nuxt dev playground",
       "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground",
       "prepack": "tsdown"
     }
   }
   ```

4. Point the `exports` of `package.json` at your module, as described in [Project Structure](/docs/guide/modules/module-builder/project-structure#packagejson).
5. Create a `tsconfig.json` that references the tsconfigs in `.nuxt`, and a `tsconfig.module.json` for module code, as described in [TypeScript](/docs/guide/modules/module-builder/typescript).

The `dev:prepare` script in step 3 is for a module that you publish with pnpm or Yarn 4. If you publish with npm, Yarn 3 or earlier, or bun, add `tsdown` before `nuxt prepare playground`. [Develop and Publish](/docs/guide/modules/module-builder/develop-and-publish#preparing-a-checkout) explains the difference.

## Next steps

- [Project Structure](/docs/guide/modules/module-builder/project-structure): the files that `@nuxt/module-builder` reads.
- [Commands](/docs/guide/modules/module-builder/commands): `tsdown`, `nuxt-module-build build`, and `nuxt-module-build prepare`.
- [Develop and Publish](/docs/guide/modules/module-builder/develop-and-publish): the two development setups, the playground, and releases.
- [Configuration](/docs/guide/modules/module-builder/configuration): `tsdown.config.ts`, extra entries, and externals.
- [TypeScript](/docs/guide/modules/module-builder/typescript): your module's `tsconfig.json`, its declarations, and the rules for module code.
- [Build Output](/docs/guide/modules/module-builder/output): the files in `dist`, and the size report.
- [Exports](/docs/guide/modules/module-builder/exports): subpath exports, including runtime components.
- [Upgrading to v2](/docs/guide/modules/module-builder/upgrade-v2): moving a module from v1.
