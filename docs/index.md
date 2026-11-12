---
title: Module Builder
description: Build and publish Nuxt modules with `@nuxt/module-builder`.
navigation:
  title: Getting Started
---

`@nuxt/module-builder` builds a Nuxt module for publishing to npm. It bundles the module entry with [tsdown](https://tsdown.dev) and transpiles the runtime directory file by file. It also generates type declarations against the module's own `.nuxt`, and writes the type shims that give `nuxt.config` autocompletion for the module's options.

The builder works with the layout of the [module starter](https://github.com/nuxt/starter/tree/module) and needs no configuration for it. To learn how to write the module itself (its definition, hooks, and the `@nuxt/kit` utilities), read the [Module Author Guide](/docs/guide/modules).

## Requirements

To build a module, you need:

- Node `^22.18.0 || >=24.0.0`.
- `tsdown` and `typescript` (`^5.9.3 || ^6.0.0`), which are peer dependencies of `@nuxt/module-builder`.
- `nuxt`, which provides the `@nuxt/cli` that `nuxt-module-build prepare` runs.

To use a module built with it, an app needs Nuxt 3 or later. The module entry is compiled for the lowest Node version in your module's `engines.node` field. Without that field, its syntax is kept as written.

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

`dev:prepare` stubs the module's `dist` directory and generates the `.nuxt` directories that type the module and its playground. See [Commands](/docs/guide/modules/module-builder/commands) for what each step does.

## Manual installation

Add the builder and its peer dependencies to an existing module:

```bash
pnpm add -D @nuxt/module-builder tsdown@^0.23.7 typescript nuxt
```

Then add the scripts that build the module before publishing and prepare it for development:

```json [package.json]
{
  "scripts": {
    "prepack": "nuxt-module-build build",
    "dev:prepare": "nuxt-module-build build --stub && nuxt-module-build prepare && nuxt prepare playground"
  }
}
```

Your module also needs the `exports` and `files` fields described in [Project structure](/docs/guide/modules/module-builder/project-structure#packagejson), and a `tsconfig.json` as described in [TypeScript](/docs/guide/modules/module-builder/typescript).

## Next steps

- [Project structure](/docs/guide/modules/module-builder/project-structure): the files the builder reads.
- [Commands](/docs/guide/modules/module-builder/commands): `build`, `build --stub`, and `prepare`.
- [Configuration](/docs/guide/modules/module-builder/configuration): extra entries and directories.
- [TypeScript](/docs/guide/modules/module-builder/typescript): the module's `tsconfig.json` and its declarations.
- [Build output](/docs/guide/modules/module-builder/output): what ends up in `dist`.
- [Exports](/docs/guide/modules/module-builder/exports): subpath exports, including runtime components.
- [Transpiling a directory](/docs/guide/modules/module-builder/transpile-dir): the `transpileDir` rolldown plugin.
- [Upgrading to v2](/docs/guide/modules/module-builder/upgrade-v2): moving a module from v1.
