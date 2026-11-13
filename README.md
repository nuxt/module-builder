# 📦 Nuxt Module Builder

[![npm version][npm-version-src]][npm-version-href]
[![License][license-src]][license-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
<a href="https://volta.net/nuxt/module-builder?utm_source=nuxt_module_builder_readme"><img src="https://user-images.githubusercontent.com/904724/209143798-32345f6c-3cf8-4e06-9659-f4ace4a6acde.svg" alt="Volta board"></a>

> The complete solution to build and ship [Nuxt modules](https://nuxt.com/modules).

## Features

- Builds modules for Nuxt 3 and later, with no configuration for the [module starter](https://github.com/nuxt/starter/tree/module) layout
- Bundles the module entry with [tsdown](https://tsdown.dev), and transpiles the runtime directory file by file
- Generates declarations against the module's own `.nuxt`, for `.ts` and `.vue` files alike
- Writes the type shims that give `nuxt.config` autocompletion for the module's options and hooks
- Stubs `dist` for development, so a playground runs the module's sources directly

## Quick start

Create a module from the [module starter](https://github.com/nuxt/starter/tree/module):

```bash
npm create nuxt -- -t module my-module
```

Building a module requires Node `^22.18.0 || >=24.0.0`, with `tsdown` and `typescript` installed alongside `@nuxt/module-builder`. Apps that install a built module need Nuxt 3 or later.

## Documentation

- [Getting started](./docs/index.md)
- [Project structure](./docs/1.project-structure.md)
- [Commands](./docs/2.commands.md): `build`, `build --stub`, and `prepare`
- [Develop and publish](./docs/3.develop-and-publish.md): the playground, and releasing to npm
- [Configuration](./docs/4.configuration.md): extra entries, and the deprecated `build.config.ts`
- [TypeScript](./docs/5.typescript.md): the module's `tsconfig.json`, and its declarations
- [Build output](./docs/6.output.md)
- [Exports](./docs/7.exports.md): subpath exports, including runtime components
- [Transpiling a directory](./docs/8.transpile-dir.md): the `transpileDir` rolldown plugin
- [Upgrading to v2](./docs/upgrade-v2.md)

For writing the module itself, read the [Nuxt Module Author Guide](https://nuxt.com/docs/guide/modules).

## 💻 Development

- Clone repository
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Try building [example module](./example) using `pnpm example:build`

Pages in [`docs/`](./docs) are written for [nuxt.com](https://nuxt.com), so links between them use nuxt.com paths.

## License

[MIT](./LICENSE) - Made with 💚

<!-- Badges -->
[npm-version-src]: https://npmx.dev/api/registry/badge/version/@nuxt/module-builder
[npm-version-href]: https://npmx.dev/package/@nuxt/module-builder

[npm-downloads-src]: https://npmx.dev/api/registry/badge/downloads/@nuxt/module-builder
[npm-downloads-href]: https://npm.chart.dev/@nuxt/module-builder

[license-src]: https://img.shields.io/github/license/nuxt/module-builder.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/nuxt/module-builder/blob/main/LICENSE
