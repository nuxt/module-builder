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
npx nuxt build-module build [ROOTDIR] [--cwd=<directory>] [--outDir=<directory>] [--sourcemap] [--stub]
npx nuxt build-module prepare [ROOTDIR] [--cwd=<directory>]
```

The `build-module` command runs the `nuxt-build-module` binary that [`@nuxt/module-builder`](/docs/guide/modules/module-builder) installs in your module. It's the same CLI as `nuxt-module-build`, with two subcommands. Without a subcommand, it runs `build` and prints a warning.

## `build`

Builds the module into `dist` for publishing. With `--stub`, it writes `dist` as re-exports of your sources instead, for development. See [`build`](/docs/guide/modules/module-builder/commands#build) and [`build --stub`](/docs/guide/modules/module-builder/commands#build-stub).

### Arguments

| Argument | Description |
|---|---|
| `ROOTDIR="."` | The module root. |

### Options

| Option | Default | Description |
|---|---|---|
| `--cwd=<directory>` | | The module root. Takes precedence over `ROOTDIR`. |
| `--outDir=<directory>` | `dist` | The output directory, relative to the module root. It's emptied before every build, so it must be inside the module. |
| `--sourcemap` | `false` | Emit a source map next to every script. |
| `--stub` | `false` | Write a stub build instead. |

## `prepare`

Generates `.nuxt` in the module root, which the module's `tsconfig.json` extends. See [`prepare`](/docs/guide/modules/module-builder/commands#prepare).

### Arguments

| Argument | Description |
|---|---|
| `ROOTDIR="."` | The module root. |

### Options

| Option | Default | Description |
|---|---|---|
| `--cwd=<directory>` | | The module root. Takes precedence over `ROOTDIR`. |
