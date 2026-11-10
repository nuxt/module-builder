# 📦 Nuxt Module Builder

[![npm version][npm-version-src]][npm-version-href]
[![License][license-src]][license-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
<a href="https://volta.net/nuxt/module-builder?utm_source=nuxt_module_builder_readme"><img src="https://user-images.githubusercontent.com/904724/209143798-32345f6c-3cf8-4e06-9659-f4ace4a6acde.svg" alt="Volta board"></a>

> The complete solution to build and ship [Nuxt modules](https://nuxt.com/modules).

## Features

- Compatible with Nuxt 3 and Nuxt Kit
- Unified build with [tsdown](https://tsdown.dev)
- Automated build config using last module spec
- Typescript and ESM support
- Auto generated types and shims for `@nuxt/schema`

We recommend to checkout the [Nuxt modules author guide](https://nuxt.com/docs/guide/going-further/modules) before starting with the module-builder.

Upgrading a module from v1? Follow the [upgrade guide](./docs/upgrade-v2.md).

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

Each file will be transformed individually to `dist/runtime/`.

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
    "@nuxt/module-builder": "latest",
    "tsdown": "^0.23.7"
  }
}
```

`tsdown` is a peer dependency, so it has to be installed alongside `@nuxt/module-builder`.

### Additional entrypoints (optional)

Module builder is essentially a preset for [tsdown](https://tsdown.dev); check out the [build command](./src/build/build.ts) for reference.

Entrypoints other than `src/module` can be listed under the `build.entries` field of your `package.json`:

```json [package.json]
{
  "build": {
    "entries": [
      "./src/utils"
    ]
  }
}
```

> [!WARNING]
> `build.config.ts` and the `unbuild` field of `package.json` are deprecated.
> Their `entries`, `externals`, `replace` and `rollup.replace` options are still applied,
> and so are the `build:before`, `rollup:done` and `build:done` hooks. `mkdist:*` hooks are
> ignored. Any other option, including other hooks and the rest of `rollup`, makes the
> build fail. See the [upgrade guide](./docs/upgrade-v2.md#build-configuration).
>
> Import `defineBuildConfig` from `@nuxt/module-builder` rather than `unbuild`. Hooks receive
> a context with `options.name`, `options.rootDir`, `options.outDir`, `options.entries`,
> `options.declaration`, `options.stub`, `options.sourcemap` and `pkg`.

## Dist files

Module builder generates dist files in `dist/` directory:

- `module.mjs`: Module entrypoint build from `src/module`
- `module.json`: Module meta extracted from `module.mjs` + `package.json`
- `types.d.mts`: Exported types in addition to shims for `nuxt.config` auto completion.
- `runtime/*`: Individually transformed files
  - JavaScript and `.ts` files will be transformed to `.js` with extracted types in a `.d.ts` file with the same name
  - `.vue` files will be transformed with extracted `.d.vue.ts` and `.vue.d.ts` files
  - `.css` files will be nested-flattened, prefixed and minified
  - `.scss` and `.sass` files will be compiled to `.css` with the module's `sass` or `sass-embedded`; `_` partials are not emitted
  - Other files will be copied as is

## Transpiling a directory with tsdown

The runtime build is a rolldown plugin, `transpileDir`, exported from `@nuxt/module-builder/rolldown` for any tsdown or rolldown build that needs a directory transpiled file by file rather than bundled:

```ts
// tsdown.config.ts
import { defineConfig } from 'tsdown'
import { transpileDir } from '@nuxt/module-builder/rolldown'

export default defineConfig({
  entry: ['src/index.ts'],
  plugins: [
    transpileDir({ srcDir: 'src/runtime', outBase: 'runtime' }),
  ],
})
```

Every file under `srcDir` is emitted under `outBase` in the build's output directory with its name intact. Scripts are transpiled with oxc and keep their imports as written, apart from relative imports, which get the emitted extension. `.vue` files go through `vue-sfc-transformer`, stylesheets are processed as above, and other files are copied. Declarations come from one TypeScript program using the nearest `tsconfig.json`. The options are documented on `TranspileDirOptions`; `resolveExternal` decides what happens to relative imports that resolve outside `srcDir`. A build with nothing to bundle can pass `emptyEntry` from the same export as its `entry`.

## 💻 Development

- Clone repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Try building [example module](./example) using `pnpm example:build`

## License

[MIT](./LICENSE) - Made with 💚

<!-- Badges -->
[npm-version-src]: https://npmx.dev/api/registry/badge/version/@nuxt/module-builder
[npm-version-href]: https://npmx.dev/package/@nuxt/module-builder

[npm-downloads-src]: https://npmx.dev/api/registry/badge/downloads/@nuxt/module-builder
[npm-downloads-href]: https://npm.chart.dev/@nuxt/module-builder

[license-src]: https://img.shields.io/github/license/nuxt/module-builder.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/nuxt/module-builder/blob/main/LICENSE
