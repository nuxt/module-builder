# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## v1.0.2

[compare changes](https://github.com/nuxt/module-builder/compare/v1.0.1...v1.0.2)

### 🩹 Fixes

- Use absolute path for jiti stub ([#648](https://github.com/nuxt/module-builder/pull/648))

### 🏡 Chore

- Add explicit semver dep ([ddb5a65](https://github.com/nuxt/module-builder/commit/ddb5a65))
- Add semver types ([50e3f6b](https://github.com/nuxt/module-builder/commit/50e3f6b))

### ✅ Tests

- Add snapshots for v3 + v4 wrapped fetch ([270779b](https://github.com/nuxt/module-builder/commit/270779b))

### 🤖 CI

- Remove forced corepack installation ([9be288b](https://github.com/nuxt/module-builder/commit/9be288b))
- Run tests on node 20 ([97e3f47](https://github.com/nuxt/module-builder/commit/97e3f47))

### ❤️ Contributors

- Bobbie Goede <bobbiegoede@gmail.com>
- Daniel Roe ([@danielroe](https://github.com/danielroe))

## v1.0.1

[compare changes](https://github.com/nuxt/module-builder/compare/v1.0.0...v1.0.1)

### 📖 Documentation

- Add full v1 release notes ([#581](https://github.com/nuxt/module-builder/pull/581), [#582](https://github.com/nuxt/module-builder/pull/582))
- Update to latest recommendations ([6b30cde](https://github.com/nuxt/module-builder/commit/6b30cde))

### ❤️ Contributors

- Daniel Roe ([@danielroe](https://github.com/danielroe))
- Connor Pearson ([@cjpearson](https://github.com/cjpearson))

## v1.0.0

[compare changes](https://github.com/nuxt/module-builder/compare/v0.8.4...v1.0.0)

### 🚀 Enhancements

- ⚠️ Upgrade to unbuild v3 ([#447](https://github.com/nuxt/module-builder/pull/447))
- ⚠️ Remove support for node10 resolution + cjs ([#448](https://github.com/nuxt/module-builder/pull/448))
- build: Ignore test + story files in runtime/ directory ([#480](https://github.com/nuxt/module-builder/pull/480))
- Add support for type exports in module re-exports ([#563](https://github.com/nuxt/module-builder/pull/563))

### 🩹 Fixes

- Mark nuxi as optional peerDep ([29a42ae](https://github.com/nuxt/module-builder/commit/29a42ae))
- Drop @nuxt/kit peer dependency & remove optionality for nuxi ([5936063](https://github.com/nuxt/module-builder/commit/5936063))
- build: Handle windows path names ([#399](https://github.com/nuxt/module-builder/pull/399))
- build: Apply resolved tsconfig to dts ([#462](https://github.com/nuxt/module-builder/pull/462))
- Handle node10 resolution + add attw test ([7309198](https://github.com/nuxt/module-builder/commit/7309198))
- Update warnings ([6291cbe](https://github.com/nuxt/module-builder/commit/6291cbe))
- Support more than one line of type exports ([0c0020f](https://github.com/nuxt/module-builder/commit/0c0020f))
- Split re-exports across multiple lines ([7154a89](https://github.com/nuxt/module-builder/commit/7154a89))
- Support star exports ([8966047](https://github.com/nuxt/module-builder/commit/8966047))

### 📖 Documentation

- Update example build script ([#359](https://github.com/nuxt/module-builder/pull/359))
- Update link to downloads count badge (9804e9e)([b9b27c3](https://github.com/nuxt/module-builder/commit/b9b27c3))
- Describe configuring unbuild ([#440](https://github.com/nuxt/module-builder/pull/440))

### 🏡 Chore

- Use tinyexec in test suite ([7ff8ef1](https://github.com/nuxt/module-builder/commit/7ff8ef1))
- Fix links ([2e57eb2](https://github.com/nuxt/module-builder/commit/3cd9cd4))
- Pin typescript until issue with vue-tsc is resolved ([994135d](https://github.com/nuxt/module-builder/commit/994135d))
- Bump vue-tsc ([e8cb0ef](https://github.com/nuxt/module-builder/commit/e8cb0ef))
- Bump nuxi version ([5b1f00e](https://github.com/nuxt/module-builder/commit/5b1f00e))
- Add publint to dev dependencies ([7281ae3](https://github.com/nuxt/module-builder/commit/7281ae3))
- Set node versions and enable knip ([1a17c0c](https://github.com/nuxt/module-builder/commit/1a17c0c))
- Stub module before stubbing playground ([b3a513b](https://github.com/nuxt/module-builder/commit/b3a513b))
- Run install command to relink binaries ([932729e](https://github.com/nuxt/module-builder/commit/932729e))
- Update command and add builder to workspace ([#482](https://github.com/nuxt/module-builder/pull/482))
- Add type assertion ([14d7788](https://github.com/nuxt/module-builder/commit/14d7788))
- Add more type-safe solution + fallback ([66d4231](https://github.com/nuxt/module-builder/commit/66d4231))
- Add pkg.pr.new for nightly/pr builds ([#573](https://github.com/nuxt/module-builder/pull/573))
- Bump to latest mkdist and add vue-sfc-transformer ([673152a](https://github.com/nuxt/module-builder/commit/673152a))
- Update knip config ([c9a28a0](https://github.com/nuxt/module-builder/commit/c9a28a0))
- Bump `vue-sfc-transformer` version ([3cd9cd4](https://github.com/nuxt/module-builder/commit/3cd9cd4))
- release: V1.0.0 (b0655d3)([3cd9cd4](https://github.com/nuxt/module-builder/commit/3cd9cd4))

### ✅ Tests

- Await file snapshot assertions ([16930b4](https://github.com/nuxt/module-builder/commit/16930b4))
- Assert current vue snapshot behaviour ([#444](https://github.com/nuxt/module-builder/pull/444))
- Update snapshots ([847d150](https://github.com/nuxt/module-builder/commit/847d150))

### 🤖 CI

- Don't run publint on windows ([330f412](https://github.com/nuxt/module-builder/commit/330f412))
- Prepare environment in lint step ([5f0f88f](https://github.com/nuxt/module-builder/commit/5f0f88f))
- Force latest corepack ([9d74ce4](https://github.com/nuxt/module-builder/commit/9d74ce4))

#### ⚠️ Breaking Changes

- ⚠️ Upgrade to unbuild v3 ([#447](https://github.com/nuxt/module-builder/pull/447))
- ⚠️ Remove support for node10 resolution + cjs ([#448](https://github.com/nuxt/module-builder/pull/448))

### ❤️ Contributors

- Daniel Roe ([@danielroe](https://github.com/danielroe))
- Dev ([@productdevbook])(https://github.com/productdevbook)
- Bobbie Goede ([@BobbieGoede])(https://github.com/BobbieGoede)

## v0.8.4

[compare changes](https://github.com/nuxt/module-builder/compare/v0.8.3...v0.8.4)

### 🩹 Fixes

- Remove `nuxt/schema` augment ([2a20ed0](https://github.com/nuxt/module-builder/commit/2a20ed0))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))

## v0.8.3

[compare changes](https://github.com/nuxt/module-builder/compare/v0.8.2...v0.8.3)

### 🩹 Fixes

- **build:** Handle missing named type exports ([#331](https://github.com/nuxt/module-builder/pull/331))

### ❤️ Contributors

- Tobias Diez <code@tobiasdiez.com>

## v0.8.2

[compare changes](https://github.com/nuxt/module-builder/compare/v0.8.1...v0.8.2)

### 🔥 Performance

- Removed unnecessary hasTypeExport check ([#310](https://github.com/nuxt/module-builder/pull/310))

### 🩹 Fixes

- **prepare:** Override `compatibilityDate` ([b9b27c3](https://github.com/nuxt/module-builder/commit/b9b27c3))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))
- Matt ([@matt-clegg](http://github.com/matt-clegg))

## v0.8.1

[compare changes](https://github.com/nuxt/module-builder/compare/v0.8.0...v0.8.1)

### 🩹 Fixes

- **build:** Export all types in stub mode ([6b1970d](https://github.com/nuxt/module-builder/commit/6b1970d))

### 🏡 Chore

- Add @danielroe to code owners ([c39cc75](https://github.com/nuxt/module-builder/commit/c39cc75))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))

## v0.8.0

[compare changes](https://github.com/nuxt/module-builder/compare/v0.7.1...v0.8.0)

### 🩹 Fixes

- ⚠️  Do not augment nuxt options inside module entry ([#295](https://github.com/nuxt/module-builder/pull/295))
- **build:** Do not export default as a type ([d29337c](https://github.com/nuxt/module-builder/commit/d29337c))
- **build:** Only generate `import type` statement if required ([190bff4](https://github.com/nuxt/module-builder/commit/190bff4))

#### ⚠️ Breaking Changes

- ⚠️  Do not augment nuxt options inside module entry ([#295](https://github.com/nuxt/module-builder/pull/295))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))

## v0.7.1

[compare changes](https://github.com/nuxt/module-builder/compare/v0.7.0...v0.7.1)

### 🩹 Fixes

- **build:** Declare `ModuleOptions` in correct place ([#283](https://github.com/nuxt/module-builder/pull/283))

### 📖 Documentation

- Update path for runtime js files ([#282](https://github.com/nuxt/module-builder/pull/282))

### ❤️ Contributors

- Adam DeHaven ([@adamdehaven](http://github.com/adamdehaven))
- Daniel Roe ([@danielroe](http://github.com/danielroe))

## v0.7.0

[compare changes](https://github.com/nuxt/module-builder/compare/v0.6.0...v0.7.0)

### 🚀 Enhancements

- Auto generate module options from schema meta ([#33](https://github.com/nuxt/module-builder/pull/33))

### 🩹 Fixes

- Use `tsconfck` to resolve tsconfig `compilerOptions` ([#274](https://github.com/nuxt/module-builder/pull/274))
- ⚠️  Use `.js` extension for files in `runtime/` directory ([dbd05bb](https://github.com/nuxt/module-builder/commit/dbd05bb))
- Resolve full path to runtime externals ([#275](https://github.com/nuxt/module-builder/pull/275))
- Include `dist/runtime` in externals list ([0946c04](https://github.com/nuxt/module-builder/commit/0946c04))

### 📖 Documentation

- Add `types` condition to export subpath ([#265](https://github.com/nuxt/module-builder/pull/265))

### 🏡 Chore

- **release:** V0.6.0 ([f56195e](https://github.com/nuxt/module-builder/commit/f56195e))
- Fix lint issue ([0fe04e8](https://github.com/nuxt/module-builder/commit/0fe04e8))

### ✅ Tests

- Add additional test for validity of types shared from runtime ([afc4374](https://github.com/nuxt/module-builder/commit/afc4374))

### 🤖 CI

- Adds reproduction workflow ([0dc73bb](https://github.com/nuxt/module-builder/commit/0dc73bb))

#### ⚠️ Breaking Changes

- ⚠️  Use `.js` extension for files in `runtime/` directory ([dbd05bb](https://github.com/nuxt/module-builder/commit/dbd05bb))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))
- Ricardo Gobbo De Souza ([@ricardogobbosouza](http://github.com/ricardogobbosouza))
- Rgehbt ([@Gehbt](http://github.com/Gehbt))

## v0.6.0

[compare changes](https://github.com/nuxt/module-builder/compare/v0.5.5...v0.6.0)

### 🚀 Enhancements

- Generate `runtime/` dts based on nuxt `tsconfig` options ([#255](https://github.com/nuxt/module-builder/pull/255))
- Add builder versions to `module.json` ([f8567a3](https://github.com/nuxt/module-builder/commit/f8567a3))
- Support transforming `jsx` ([4841f2e](https://github.com/nuxt/module-builder/commit/4841f2e))

### 🩹 Fixes

- ⚠️  Remove support for deprecated `RuntimeModuleHooks` interface ([#228](https://github.com/nuxt/module-builder/pull/228))
- Add `-nightly` versions to externals ([0a88a87](https://github.com/nuxt/module-builder/commit/0a88a87))
- Ignore exporting type if it is not defined ([c308cc5](https://github.com/nuxt/module-builder/commit/c308cc5))
- Mark `runtime/` directory as external ([7a68e1e](https://github.com/nuxt/module-builder/commit/7a68e1e))

### 🏡 Chore

- **release:** V0.5.5 ([f158ffa](https://github.com/nuxt/module-builder/commit/f158ffa))
- Dedupe kit/schema/vue versions ([aa0a710](https://github.com/nuxt/module-builder/commit/aa0a710))
- Add root `dev:prepare` command ([c308a68](https://github.com/nuxt/module-builder/commit/c308a68))
- Migrate to eslint v9 ([#250](https://github.com/nuxt/module-builder/pull/250))
- Improve internal type safety and enable strict mode ([78aa088](https://github.com/nuxt/module-builder/commit/78aa088))
- Tweak tsconfig settings ([404aae7](https://github.com/nuxt/module-builder/commit/404aae7))
- Add more type annotations ([ba0614b](https://github.com/nuxt/module-builder/commit/ba0614b))

### ✅ Tests

- Update type testing step ([#256](https://github.com/nuxt/module-builder/pull/256))
- Add inline snapshots for `runtime/` transforms ([#257](https://github.com/nuxt/module-builder/pull/257))
- Update snapshot ([a39c183](https://github.com/nuxt/module-builder/commit/a39c183))

### 🎨 Styles

- Lint ([c15fd92](https://github.com/nuxt/module-builder/commit/c15fd92))
- Lint ([3b805ec](https://github.com/nuxt/module-builder/commit/3b805ec))

#### ⚠️ Breaking Changes

- ⚠️  Remove support for deprecated `RuntimeModuleHooks` interface ([#228](https://github.com/nuxt/module-builder/pull/228))

### ❤️ Contributors

- Daniel Roe ([@danielroe](http://github.com/danielroe))

## v0.5.5

[compare changes](https://github.com/nuxt/module-builder/compare/v0.5.4...v0.5.5)

### 🩹 Fixes

- Rename `RuntimeModuleHooks` to `ModuleRuntimeHooks` ([#194](https://github.com/nuxt/module-builder/pull/194))
- Use import with extension in generated `.d.mts` file ([#202](https://github.com/nuxt/module-builder/pull/202))

### 📖 Documentation

- Remove reference to `ModulePrivateRuntimeConfig` ([34ee148](https://github.com/nuxt/module-builder/commit/34ee148))

### 🏡 Chore

- Add shell emulator for Windows ([#191](https://github.com/nuxt/module-builder/pull/191))
- Fix example `package.json` ([#192](https://github.com/nuxt/module-builder/pull/192))

### ✅ Tests

- Add root + module type tests ([#198](https://github.com/nuxt/module-builder/pull/198))

### 🤖 CI

- Run tests on node 18 ([81b7b4c](https://github.com/nuxt/module-builder/commit/81b7b4c))

### ❤️ Contributors

- Joaquín Sánchez ([@userquin](http://github.com/userquin))
- Bobbie Goede <bobbiegoede@gmail.com>
- Daniel Roe <daniel@roe.dev>

## v0.5.4

[compare changes](https://github.com/nuxt/module-builder/compare/v0.5.3...v0.5.4)

### 🚀 Enhancements

- Support writing `RuntimeNuxtHooks` types ([#183](https://github.com/nuxt/module-builder/pull/183))

### 🩹 Fixes

- Generate explicit type import/exports ([#184](https://github.com/nuxt/module-builder/pull/184))

### 📖 Documentation

- Import nuxt composables from #imports ([#186](https://github.com/nuxt/module-builder/pull/186))

### ❤️ Contributors

- Bobbie Goede <bobbiegoede@gmail.com>
- Daniel Roe ([@danielroe](http://github.com/danielroe))

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
