# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## v0.5.3

[compare changes](https://github.com/nuxt/module-builder/compare/v0.5.2...v0.5.3)

### 🩹 Fixes

- Esnext-compatible output ([#181](https://github.com/nuxt/module-builder/pull/181))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))

## v0.5.2

[compare changes](https://github.com/nuxt/module-builder/compare/v0.5.1...v0.5.2)

### 💅 Refactors

- Migrate to `citty` ([#169](https://github.com/nuxt/module-builder/pull/169))

### 📖 Documentation

- Fix typo ([#174](https://github.com/nuxt/module-builder/pull/174))

### 🏡 Chore

- **release:** V0.5.1 ([fc3a760](https://github.com/nuxt/module-builder/commit/fc3a760))

### ❤️ Contributors

- Daniel Roe <daniel@roe.dev>
- Pionxzh <spigbbbbb@gmail.com>

## v0.5.1

[compare changes](https://github.com/nuxt/module-builder/compare/v0.5.0...v0.5.1)

### 🚀 Enhancements

- Support `--sourcemap` option ([#163](https://github.com/nuxt/module-builder/pull/163))

### ❤️ Contributors

- Bobbie Goede <bobbiegoede@gmail.com>

## v0.5.0

[compare changes](https://github.com/nuxt/module-builder/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- Expose `prepareModule` function ([76b5654](https://github.com/nuxt/module-builder/commit/76b5654))
- Upgrade to `unbuild@2` ([#161](https://github.com/nuxt/module-builder/pull/161))

### 🏡 Chore

- Add type safety to prepare overrides ([9d0804a](https://github.com/nuxt/module-builder/commit/9d0804a))
- Switch to changelogen for release ([ba811da](https://github.com/nuxt/module-builder/commit/ba811da))

### ❤️ Contributors

- Daniel Roe <daniel@roe.dev>
- Anthony Fu <anthonyfu117@hotmail.com>

## [0.4.0](https://github.com/nuxt/module-builder/compare/v0.3.1...v0.4.0) (2023-05-26)


### Features

* add `prepare` command for local types support ([#124](https://github.com/nuxt/module-builder/issues/124)) ([612c6b2](https://github.com/nuxt/module-builder/commit/612c6b29a6bad321764d1b0d48d28ada56677f85))

### [0.3.1](https://github.com/nuxt/module-builder/compare/v0.3.0...v0.3.1) (2023-05-01)


### Bug Fixes

* extend `nuxt/schema` as well ([796d6ab](https://github.com/nuxt/module-builder/commit/796d6ab161f753b3cce66ebf182f1f46b22f2a7c))

## [0.3.0](https://github.com/nuxt/module-builder/compare/v0.2.1...v0.3.0) (2023-04-11)

### [0.2.1](https://github.com/nuxt/module-builder/compare/v0.2.0...v0.2.1) (2022-11-16)

## [0.2.0](https://github.com/nuxt/module-builder/compare/v0.1.7...v0.2.0) (2022-10-15)


### Features

* export all module types in `types.d.ts` ([#46](https://github.com/nuxt/module-builder/issues/46)) ([64f3ba5](https://github.com/nuxt/module-builder/commit/64f3ba5e89471fb3dfed0cf83411f90c584f205c))
* support `ModuleRuntimeConfig` and `ModulePublicRuntimeConfig` type exports ([#45](https://github.com/nuxt/module-builder/issues/45)) ([a552495](https://github.com/nuxt/module-builder/commit/a5524952ef09ed3748e46db71b6e989611253076))
* support `outDir` option  ([#37](https://github.com/nuxt/module-builder/issues/37)) ([6453ed0](https://github.com/nuxt/module-builder/commit/6453ed0bc104f7ef167f9f16bc012968d1b9261d))


### Bug Fixes

* **pkg:** export `./package.json` subpath ([#47](https://github.com/nuxt/module-builder/issues/47)) ([82ab400](https://github.com/nuxt/module-builder/commit/82ab400f236bbc8aacaaddfabb62dcf292d5b698))

### [0.1.7](https://github.com/nuxt/module-builder/compare/v0.1.6...v0.1.7) (2022-01-18)


### Bug Fixes

* ensure nuxt packages are externalized ([ebad137](https://github.com/nuxt/module-builder/commit/ebad137dea9cc3d45659dc7cdb6446ee81e82e96))

### [0.1.6](https://github.com/nuxt/module-builder/compare/v0.1.5...v0.1.6) (2022-01-17)


### Bug Fixes

* typo meta.json => module.json ([55863c1](https://github.com/nuxt/module-builder/commit/55863c110af7aea562c3ffb3e4681f9b1b61446b))

### [0.1.5](https://github.com/nuxt/module-builder/compare/v0.1.4...v0.1.5) (2022-01-17)


### Bug Fixes

* add default export for `types.d.ts` ([885c02f](https://github.com/nuxt/module-builder/commit/885c02f0285679ab437ae3e9b5dca8436a8e84f8))

### [0.1.4](https://github.com/nuxt/module-builder/compare/v0.1.3...v0.1.4) (2022-01-17)


### Features

* parse `module.d` exports to generate ModuleOptions conditionally ([9cd8282](https://github.com/nuxt/module-builder/commit/9cd828203623d25c325129b0bd2d1fa40470b55a))
* support `--stub` ([746d59b](https://github.com/nuxt/module-builder/commit/746d59bd95ddc3dd63c89db01193c764f6f0bdde))
* support `ModuleHooks` type export ([269ce20](https://github.com/nuxt/module-builder/commit/269ce20b33377707c2e7a9460cdc3403afacb285))

### [0.1.3](https://github.com/nuxt/module-builder/compare/v0.1.2...v0.1.3) (2022-01-17)


### Features

* generate module.json file ([ac12805](https://github.com/nuxt/module-builder/commit/ac12805b71848d9abbf8daa68a88ede4df5a5c6c))


### Bug Fixes

* win32 support ([#14](https://github.com/nuxt/module-builder/issues/14)) ([c8ab1ad](https://github.com/nuxt/module-builder/commit/c8ab1ad68c28913aeecf46bf3288ed316e3e1d8e))

### [0.1.2](https://github.com/nuxt/module-builder/compare/v0.1.1...v0.1.2) (2021-12-23)


### Bug Fixes

* **pkg:** only include dist ([d2ff7e4](https://github.com/nuxt/module-builder/commit/d2ff7e4168363dd4e8a93dc9c909e6f6e07765ff))

### 0.1.1 (2021-12-23)


### Features

* poc for schema types generation ([4991907](https://github.com/nuxt/module-builder/commit/49919078806b95e8d9bde64b708cb430a3bb09cf))


### Bug Fixes

* emit cjs stub before validation ([0154bc5](https://github.com/nuxt/module-builder/commit/0154bc51db2246217287c0fba4d9be42955fa306))
* improve types generation ([68c02e6](https://github.com/nuxt/module-builder/commit/68c02e60ab4f504c6b7d078c7e8e5fb13cb81e37))
