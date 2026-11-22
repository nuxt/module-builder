# Test fixture

This module is the fixture that the tests of `@nuxt/module-builder` copy and modify. It keeps edge cases on purpose, such as entries in the `build` field of `package.json` without a `tsdown.config.ts`, `typesVersions`, and an extensionless type import, so it isn't a template for a new module.

To create a module, use the [module starter](https://github.com/nuxt/starter/tree/module), and follow [Getting Started](../docs/index.md).
