---
title: 'nuxt build-module'
description: 'Build a Nuxt module for publishing, or prepare it for development, with `@nuxt/module-builder`.'
links:
  - label: Source
    icon: i-simple-icons-github
    to: https://github.com/nuxt/module-builder/tree/main/src/commands
    size: xs
---

```bash [Terminal]
npx nuxt build-module build [ROOTDIR] [--cwd=<directory>] [--outDir=<directory>] [--sourcemap]
npx nuxt build-module prepare [ROOTDIR] [--cwd=<directory>]
```

The `build-module` command runs the `nuxt-build-module` binary that [`@nuxt/module-builder`](/docs/guide/modules/module-builder) installs in your module. It's the same CLI as `nuxt-module-build`, with two subcommands. Without a subcommand, it prints its usage.

## `build`

Builds the module into `dist` for publishing. When the module has a `tsdown.config.ts`, `build` uses it. It produces the same output as `tsdown`. See [`build`](/docs/guide/modules/module-builder/commands#build).

### Arguments

| Argument | Description |
|---|---|
| `ROOTDIR="."` | The module root. |

### Options

| Option | Default | Description |
|---|---|---|
| `--cwd=<directory>` | | The module root. Takes precedence over `ROOTDIR`. |
| `--outDir=<directory>` | | The output directory, relative to the module root. Takes precedence over `outDir` in the tsdown config, which defaults to `dist`. It's emptied before every build, so it must be inside the module. |
| `--sourcemap` | | Emit a source map next to every script. Takes precedence over `sourcemap` in the tsdown config. |

## `prepare`

Generates `.nuxt` in the module root, whose tsconfigs the module's `tsconfig.json` references. It also writes the declarations that the root export's `types` condition points at while `package.json` points at the module's sources. See [`prepare`](/docs/guide/modules/module-builder/commands#prepare).

### Arguments

| Argument | Description |
|---|---|
| `ROOTDIR="."` | The module root. |

### Options

| Option | Default | Description |
|---|---|---|
| `--cwd=<directory>` | | The module root. Takes precedence over `ROOTDIR`. |
