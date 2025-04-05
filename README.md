# 📦 Nuxt Module Builder

[![npm version][npm-version-src]][npm-version-href]
[![License][license-src]][license-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
<a href="https://volta.net/nuxt/module-builder?utm_source=nuxt_module_builder_readme"><img src="https://user-images.githubusercontent.com/904724/209143798-32345f6c-3cf8-4e06-9659-f4ace4a6acde.svg" alt="Volta board"></a>

> The complete solution to build and ship [Nuxt modules](https://nuxt.com/modules).

## Features

- Compatible with Nuxt 3 and Nuxt Kit
- Unified build with [unjs/unbuild](https://github.com/unjs/unbuild)
- Automated build config using last module spec
- Typescript and ESM support
- Auto generated types and shims for `@nuxt/schema`

We recommend to checkout the [Nuxt modules author guide](https://nuxt.com/docs/guide/going-further/modules) before starting with the module-builder.

## Requirements

For a user to use a module generated from module-builder, it's recommended they have:
- Node.js >= 18.x. _Latest Node LTS preferred_
- Nuxt 3+.

## Quick start

Get started with our [module starter](https://github.com/nuxt/starter/tree/module):

```bash
npm create nuxt -- -t module my-module
```

## Project structure

The module builder requires a special project structure. You can check out the [module template](https://github.com/nuxt/starter/tree/module).

### `src/module.ts`

The entrypoint for module definition.

A default export using `defineNuxtModule` and `ModuleOptions` type export is expected.

You could also optionally export `ModuleHooks` or `ModuleRuntimeHooks` to annotate any custom hooks the module uses.

```ts [src/module.ts]
import { defineNuxtModule } from '@nuxt/kit'

export interface ModuleOptions {
  apiKey: string
}

export interface ModuleHooks {
  'my-module:init': any
}

export interface ModuleRuntimeHooks {
  'my-module:runtime-hook': any
}

export interface ModuleRuntimeConfig {
  PRIVATE_NAME: string
}

export interface ModulePublicRuntimeConfig {
  NAME: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'my-module',
    configKey: 'myModule'
  },
  defaults: {
    apiKey: 'test'
  },
  async setup (moduleOptions, nuxt) {
    // Write module logic in setup function
  }
})
```

### `src/runtime/`

Any runtime file and code that we need to provide by module including plugins, composables and server api, should be in this directory.

Each file will be transformed individually using [unjs/mkdist](https://github.com/unjs/mkdist) to `dist/runtime/`.

<!-- TODO: Docs about how to address runtime from within setup -->

### `package.json`:

A minimum `package.json` should look like this:

```json [package.json]
{
  "name": "my-module",
  "license": "MIT",
  "version": "1.0.0",
  "exports": {
    ".": {
      "types": "./dist/types.d.mts",
      "import": "./dist/module.mjs"
    }
  },
  "main": "./dist/module.mjs",
  "typesVersions": {
    "*": {
      ".": [
        "./dist/types.d.mts"
      ]
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "prepack": "nuxt-module-build build"
  },
  "dependencies": {
    "@nuxt/kit": "latest"
  },
  "devDependencies": {
    "@nuxt/module-builder": "latest"
  }
}
```

### `build.config.ts` (optional)

Module builder is essentially a preset for [unjs/unbuild](https://github.com/unjs/unbuild), check out the [build command](./src/commands/build.ts#L51) for reference.

To customize/extend the unbuild configuration you can add a `build.config.ts` in the root of your project:

```ts
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  // set additional configuration or customize using hooks
})
```

## Dist files

Module builder generates dist files in `dist/` directory:

- `module.mjs`: Module entrypoint build from `src/module`
- `module.json`: Module meta extracted from `module.mjs` + `package.json`
- `types.d.mts`: Exported types in addition to shims for `nuxt.config` auto completion.
- `runtime/*`: Individually transformed files using [unjs/mkdist](https://github.com/unjs/mkdist)
  - Javascript and `.ts` files will be transformed to `.js` with extracted types on `.d.ts` file with same name
  - `.vue` files will be transformed with extracted `.d.ts` file
  - Other files will be copied as is

## 💻 Development

- Clone repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Try building [example module](./example) using `pnpm example:build`

## License

[MIT](./LICENSE) - Made with 💚

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/@nuxt/module-builder/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@nuxt/module-builder

[npm-downloads-src]: https://img.shields.io/npm/dt/@nuxt/module-builder.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npm.chart.dev/@nuxt/module-builder

[license-src]: https://img.shields.io/github/license/nuxt/module-builder.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/nuxt/module-builder/blob/main/LICENSE
