---
title: Module Builder
description: Build and publish Nuxt modules with `@nuxt/module-builder`.
navigation:
  title: Getting Started
---

`@nuxt/module-builder` builds a Nuxt module for publishing to npm. Its `builder()` plugin makes [tsdown](https://tsdown.dev) bundle the module entry and transpile the runtime directory file by file. It also generates type declarations against the module's own `.nuxt`, and writes the type shims that give `nuxt.config` autocompletion for the module's options.

The builder works with the layout of the [module starter](https://github.com/nuxt/starter/tree/module) and needs no options for it. To learn how to write the module itself (its definition, hooks, and the `@nuxt/kit` utilities), read the [Module Author Guide](/docs/guide/modules).

## Requirements

To build a module, you need:

- Node `^22.18.0 || >=24.0.0`.
- `tsdown` and `typescript` (`^5.9.3 || ^6.0.0`), which are peer dependencies of `@nuxt/module-builder`.
- `nuxt`, which provides the `@nuxt/cli` that `nuxt-module-build prepare` runs.

To use a module built with it, an app needs Nuxt 3 or later. The module entry is compiled for the lowest Node version in your module's `engines.node` field. Without that field, its syntax is kept as written.

::note
Nuxt 3 has reached end of life, so these docs describe Nuxt 4 and later. Where Nuxt 3 behaves differently, such as type-checking all of a module's runtime files in a single context, they don't cover it.
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

`dev:prepare` generates the `.nuxt` directories that type the module and its playground. See [Develop and Publish](/docs/guide/modules/module-builder/develop-and-publish) for what each step does.

## Manual installation

Add the builder and its peer dependencies to an existing module:

```bash
pnpm add -D @nuxt/module-builder tsdown@^0.23.7 typescript nuxt
```

Add a `tsdown.config.ts` with the `builder()` plugin:

```ts [tsdown.config.ts]
import { builder } from '@nuxt/module-builder/tsdown'
import { defineConfig } from 'tsdown'

export default defineConfig({
  plugins: [builder()],
})
```

Then add the scripts that build the module before publishing and prepare it for development:

```json [package.json]
{
  "scripts": {
    "prepack": "tsdown",
    "dev:prepare": "nuxt-module-build prepare && nuxt prepare playground"
  }
}
```

This `dev:prepare` suits a module that pnpm or Yarn 4 publishes, with `package.json` pointing at its sources. With npm, Yarn 3 or earlier, or bun, add `tsdown` before `nuxt prepare playground`. See [Develop and Publish](/docs/guide/modules/module-builder/develop-and-publish#preparing-a-checkout).

Your module also needs the `exports` and `files` fields described in [Project structure](/docs/guide/modules/module-builder/project-structure#packagejson), and a `tsconfig.json` as described in [TypeScript](/docs/guide/modules/module-builder/typescript).

## Next steps

- [Project structure](/docs/guide/modules/module-builder/project-structure): the files the builder reads.
- [Commands](/docs/guide/modules/module-builder/commands): `tsdown`, `build`, and `prepare`.
- [Develop and Publish](/docs/guide/modules/module-builder/develop-and-publish): the playground, and releasing to npm.
- [Configuration](/docs/guide/modules/module-builder/configuration): `tsdown.config.ts`, extra entries, and directories.
- [TypeScript](/docs/guide/modules/module-builder/typescript): the module's `tsconfig.json` and its declarations.
- [Build output](/docs/guide/modules/module-builder/output): what ends up in `dist`.
- [Exports](/docs/guide/modules/module-builder/exports): subpath exports, including runtime components.
- [Transpiling a directory](/docs/guide/modules/module-builder/transpile-dir): the `transpileDir` rolldown plugin.
- [Upgrading to v2](/docs/guide/modules/module-builder/upgrade-v2): moving a module from v1.
