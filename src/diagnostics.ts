import { styleText } from 'node:util'
import { existsSync } from 'node:fs'
import { hyperlink, link as linkPath } from 'clickable-path'
import { defineDiagnostics, Diagnostic } from 'nostics'
import type { DiagnosticReporter, Diagnostics } from 'nostics'
import type { Logger } from 'tsdown'

import pkg from '../package.json' with { type: 'json' }
import type { ModuleCodeIssue } from './build/loader.ts'
import { escapeRegExp, logger } from './utils.ts'

function list(values: string[]) {
  return [...new Set(values)].map(value => `\`${value}\``).join(', ')
}

const UNPUBLISHABLE = 'TypeScript sources or paths that `files` leaves out'

interface UnpublishableItem {
  /** The field or `imports` key that points at `path`. */
  name: string
  path: string
  reason: 'source' | 'files'
}

function describeUnpublishable(items: UnpublishableItem[]) {
  return ([['source', 'TypeScript sources, which Node does not load from `node_modules`'], ['files', 'paths that the pack leaves out']] as const).flatMap(([reason, what]) => {
    const matching = items.filter(item => item.reason === reason)
    return matching.length ? [`Pointing at ${what}: ${list(matching.map(({ name }) => name))} (${list(matching.map(({ path }) => path))}).`] : []
  }).join(' ')
}

/** Definitions of the {@link errors}. */
export const errorCodes = {
  NUXT_MB_B0001: {
    why: (p: { issues: ModuleCodeIssue[] }): string => [
      'Module code has to load with Node, which strips types and resolves imports as written:',
      ...new Set(p.issues.map(({ file, line, column, importedBy, message }) => `  - ${file}:${line}:${column}${importedBy ? ` (imported by ${importedBy})` : ''}: ${message}`)),
    ].join('\n'),
    fix: 'Change each one as suggested.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#module-code-loads-with-node',
  },
  NUXT_MB_B0002: {
    why: (p: { file: string, reason: string }): string => `Cannot load \`${p.file}\` to write \`module.json\`: ${p.reason}`,
    fix: 'Fix the error, so that Node can import the built module. Code that only works inside a Nuxt app belongs in `setup()` or in a runtime file.',
    docs: false,
  },
  NUXT_MB_B0003: {
    why: '`@nuxt/module-builder` builds with `tsdown`, which is a peer dependency and is not installed.',
    fix: (): string => `Install it in your module: \`pnpm add -D tsdown@"${pkg.peerDependencies.tsdown}"\`.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#install-tsdown',
  },
  NUXT_MB_B0201: {
    why: (p: { message: string }): string => p.message,
    fix: (p: { command: string }): string => `Run the module's own type check, \`${p.command}\`, and fix the errors that it reports. Those that it doesn't report come from build-time aliases such as \`#build/*\`, which are typed as \`any\` while declarations are generated, and can be ignored.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#other-type-errors',
  },

  NUXT_MB_C0001: {
    why: (p: { options: Array<{ option: string, reason: string }> }): string => [
      '`builder()` sets these tsdown options itself, and the tsdown config sets them too:',
      ...p.options.map(({ option, reason }) => `  - \`${option}\`: ${reason}`),
    ].join('\n'),
    fix: 'Remove each of them from the tsdown config.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#options-builder-sets',
  },
  NUXT_MB_C0002: {
    why: (p: { options: string[] }): string => `Another tsdown plugin changed ${list(p.options)}, which \`builder()\` sets.`,
    fix: 'Configure the plugin to leave these options unchanged, or remove it.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#options-builder-sets',
  },
  NUXT_MB_C0003: {
    why: (p: { files: string[] }): string => `The bundled entries were not emitted at the file names that \`builder()\` sets: ${list(p.files)}.`,
    fix: 'Leave `outputOptions.entryFileNames` unchanged in the tsdown config and its plugins.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#options-builder-sets',
  },
  NUXT_MB_C0004: {
    why: 'The same `builder()` plugin is used in more than one tsdown config.',
    fix: 'Call `builder()` in each config that builds the module.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#tsdown-config',
  },
  NUXT_MB_C0005: {
    why: (p: { file: string }): string => `\`${p.file}\` does not build the module with \`builder()\`.`,
    fix: 'Add the plugin:\n\n  import { builder } from \'@nuxt/module-builder/tsdown\'\n  import { defineConfig } from \'tsdown\'\n\n  export default defineConfig({\n    plugins: [builder()],\n  })',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#tsdown-config',
  },
  NUXT_MB_C0006: {
    why: (p: { file: string }): string => `\`${p.file}\` uses \`builder()\` in more than one config.`,
    fix: 'Build the module with one of them.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#tsdown-config',
  },
  NUXT_MB_C0007: {
    why: (p: { file: string }): string => `\`${p.file}\` sets \`cwd\`, but \`prepare\` reads the module in the directory of the tsdown config.`,
    fix: 'Move the tsdown config into the module, or remove `cwd`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#tsdown-config',
  },
  NUXT_MB_C0008: {
    why: '`builder()` does not take `hooks`.',
    fix: 'Use tsdown\'s own `hooks` in the tsdown config, or a plugin that emits extra files.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#hooks-in-a-tsdown-config',
  },
  NUXT_MB_C0009: {
    why: (p: { options: string[] }): string => ['`builder()` does not support these options:', ...p.options.map(option => `  - ${option}`)].join('\n'),
    fix: 'Remove each of them, and set tsdown options in the tsdown config instead.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#tsdown-config',
  },
  NUXT_MB_C0010: {
    why: 'A bundled entry is named `types`, so its declarations would replace the generated `types.d.mts`.',
    fix: (p: { input: string }): string => `Give \`${p.input}\` another \`name\`.`,
    docs: false,
  },
  NUXT_MB_C0011: {
    why: (p: { file: string, outDir: string }): string => `A directory entry emits \`${p.file}\` at the root of \`${p.outDir}\`, which would replace the generated \`types.d.mts\`.`,
    fix: 'Rename the file, or give the directory entry another `outDir`.',
    docs: false,
  },
  NUXT_MB_C0012: {
    why: (p: { label: string, path: string }): string => `\`${p.label}\` resolves to \`${p.path}\`, which is not inside the module root; the build empties the output directory first.`,
    fix: 'Use a directory inside the module such as `dist`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#output-directory',
  },

  NUXT_MB_C0101: {
    why: (p: { items: UnpublishableItem[] }): string => `These published fields of \`package.json\` would not work once installed. ${describeUnpublishable(p.items)}`,
    fix: 'Point them at the build output, in `publishConfig` when `package.json` points at the sources. To publish a file other than a TypeScript source as it is, add it to `files`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#publishing-source-exports',
  },
  NUXT_MB_C0102: {
    why: (p: { items: UnpublishableItem[] }): string => `The build output imports these \`imports\` of \`package.json\`, which would not work once installed. ${describeUnpublishable(p.items)}`,
    fix: 'Point them at the build output, in `publishConfig` when `package.json` points at the sources. To publish a file other than a TypeScript source as it is, add it to `files`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#publishing-source-exports',
  },
  NUXT_MB_C0103: {
    why: (p: { fields: string[], paths: string[] }): string => `These fields of \`publishConfig\` point at ${UNPUBLISHABLE}, so they would be published that way: ${list(p.fields)} (${list(p.paths)}).`,
    fix: 'Point them at `dist`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#publishing-source-exports',
  },
  NUXT_MB_C0104: {
    why: (p: { client: string, fields: string[], paths: string[] }): string => `${p.client} packs these fields of \`package.json\` as written, and they point at ${UNPUBLISHABLE}: ${list(p.fields)} (${list(p.paths)}).`,
    fix: (p: { alternatives: string }): string => `Point them at \`dist\`, or pack and publish with ${p.alternatives}, which replace them with the \`dist\` paths in \`publishConfig\`.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#publishing-source-exports',
  },
  NUXT_MB_C0105: {
    why: (p: { fields: string[], paths: string[] }): string => `These fields of \`package.json\` point at ${UNPUBLISHABLE}, and \`publishConfig\` does not replace them, so they would be published as written: ${list(p.fields)} (${list(p.paths)}).`,
    fix: (p: { fields: string[] }): string => `Set ${list(p.fields.map(field => `publishConfig.${field}`))} to the \`dist\` paths.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#publishing-source-exports',
  },

  NUXT_MB_C0302: {
    why: (p: { path: string, reason: string, tsconfig: 'own' | 'parent' | 'referenced' }): string => `Cannot read \`${p.path}\`, ${{ own: 'the module\'s tsconfig', parent: 'the nearest tsconfig above the module, which has no `tsconfig.json` of its own', referenced: 'a project that the tsconfig of the module references' }[p.tsconfig]}: ${p.reason}`,
    fix: (p: { tsconfig: 'own' | 'parent' | 'referenced' }): string => p.tsconfig === 'parent' ? 'Give the module a `tsconfig.json` and a `tsconfig.module.json` of its own, as described in the upgrade guide, before you run `prepare` or build.' : 'Fix the tsconfig, or generate the file that it names before you run `prepare` or build.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#other-tsconfig-layouts',
  },

  NUXT_MB_D0001: {
    why: (p: { command: string }): string => `The \`--stub\` option of \`${p.command}\` has been removed.`,
    fix: 'With pnpm or Yarn 4, point `package.json` at the module\'s sources. Otherwise, build `dist` with `tsdown` and rebuild it with `tsdown --watch`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#stub-builds',
  },
  NUXT_MB_D0002: {
    why: (p: { file: string | undefined, field: string | undefined }): string => `${p.file ? `\`${p.file}\`` : `The \`${p.field}\` field of \`package.json\``} configures the build, and so does \`builder()\` in the tsdown config.`,
    fix: (p: { file: string | undefined }): string => `Move its options into \`builder()\` and ${p.file ? 'delete the file' : 'remove the field'}.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#moving-from-buildconfigts',
  },
  NUXT_MB_D0003: {
    why: (p: { file: string }): string => `\`${p.file}\` exports a function, and \`@nuxt/module-builder\` v2 only reads a config object.`,
    fix: 'Replace the function with the object it returns.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#other-options',
  },
  NUXT_MB_D0004: {
    why: (p: { options: Array<{ option: string, section: string }> }): string => [
      'The build config uses options that `@nuxt/module-builder` v2 does not support:',
      ...p.options.map(({ option, section }) => `  - ${option} (https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#${section})`),
    ].join('\n'),
    fix: 'Remove each of them from the file named.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#unsupported-build-options',
  },
} as const

/** Definitions of the {@link warnings}. */
export const warningCodes = {
  NUXT_MB_B0101: {
    why: '`.nuxt` not found, running `nuxt-module-build prepare` first.',
    fix: 'Add `nuxt-module-build prepare` to the module\'s `dev:prepare` script to skip this step.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#preparing-nuxt',
  },
  NUXT_MB_B0202: {
    why: 'Declaration generation failed under `isolatedDeclarations`, which requires an explicit type annotation on every exported value.',
    fix: 'Give each export that an error names an explicit type. Write the module entry as:\n\n  const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({ /* ... */ })\n  export default module\n\nrather than `export default defineNuxtModule<ModuleOptions>({ /* ... */ })`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#isolated-declarations',
  },
  NUXT_MB_B0203: {
    why: 'Type declarations could not be generated because of TypeScript errors.',
    fix: 'Give each export whose inferred type cannot be named (TS2742, TS2883 or TS4023) an explicit type annotation. If `.nuxt` is out of date, run `nuxt-module-build prepare` and build again.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#declaration-errors',
  },
  NUXT_MB_B0204: {
    why: (p: { errors: string[] }): string => [
      'Declarations of module code, which the module\'s own app, server and shared type checks read for its package name, could not be generated for every file. The other declarations were written.',
      ...p.errors,
    ].join('\n'),
    fix: 'Give each export that an error names an explicit type annotation, then run `nuxt-module-build prepare` again.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#portability-errors',
  },
  NUXT_MB_B0205: {
    why: 'The declarations of the module entry are generated with tsc, as its tsconfig does not set `isolatedDeclarations`.',
    fix: (p: { project: string | undefined }): string => `Set \`isolatedDeclarations: true\` in ${!p.project ? 'your `tsconfig.json`' : p.project.startsWith('.nuxt') ? 'a `tsconfig.module.json` that extends `./.nuxt/tsconfig.node.json`' : `\`${p.project}\``} to generate them with oxc, which is faster.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#isolated-declarations',
  },

  NUXT_MB_C0201: {
    why: (p: { path: string }): string => `\`types\` in \`package.json\` points at \`${p.path}\`, which the build does not produce.`,
    fix: 'Set it to `./dist/types.d.mts`, which node10 module resolution reads, or remove it: bundler module resolution reads `exports` instead.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#the-types-field',
  },
  NUXT_MB_C0202: {
    why: (p: { paths: Array<{ path: string, replacement: string }> }): string => `These \`typesVersions\` paths in \`package.json\` do not resolve under TypeScript's node10 module resolution, which probes for \`.d.ts\` but not for \`.d.mts\`: ${list(p.paths.map(({ path }) => path))}.`,
    fix: (p: { paths: Array<{ path: string, replacement: string }> }): string => `Write each path with its extension: ${p.paths.map(({ path, replacement }) => `\`${replacement}\` for \`${path}\``).join(', ')}.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#typesversions-paths',
  },
  NUXT_MB_C0203: {
    why: (p: { paths: string[] }): string => `These paths in \`package.json\` do not exist after the build, so imports that resolve to them will fail: ${list(p.paths)}.`,
    fix: 'Add the entry that produces each one, or remove the path.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#paths-the-build-does-not-produce',
  },
  NUXT_MB_C0301: {
    why: (p: { path: string }): string => `\`${p.path}\` takes its generated types from another app's \`.nuxt\`; declarations are generated with \`.nuxt/tsconfig.json\` instead.`,
    fix: (p: { inside: boolean }): string => `${p.inside ? 'Reference the module\'s own tsconfigs from it instead' : 'Add a `tsconfig.json` to the module directory that references the module\'s own tsconfigs'}: \`./tsconfig.module.json\`, which extends \`./.nuxt/tsconfig.node.json\`, and \`./.nuxt/tsconfig.app.json\`, \`./.nuxt/tsconfig.server.json\` and \`./.nuxt/tsconfig.shared.json\`.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#other-tsconfig-layouts',
  },
  NUXT_MB_C0303: {
    why: (p: { groups: Array<[path: string, files: number]> }): string => `No project that \`tsconfig.json\` references includes these TypeScript files, so \`vue-tsc -b\` does not type check them: ${p.groups.map(([path, files]) => path.endsWith('/') ? `\`${path}\` (${files} ${files === 1 ? 'file' : 'files'})` : `\`${path}\``).join(', ')}.`,
    fix: 'Reference a tsconfig that includes them, such as a `tsconfig.test.json` for tests and config files, or add them to the `exclude` of `tsconfig.json`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#tests-and-config-files',
  },

  NUXT_MB_D0101: {
    why: (p: { file: string }): string => `\`${p.file}\` is deprecated. Its options are still applied.`,
    fix: (p: { importsUnbuild: boolean }): string => `${p.importsUnbuild ? 'Import `defineBuildConfig` from `@nuxt/module-builder` instead of `unbuild`. ' : ''}Move the options into \`builder()\` in \`tsdown.config.ts\`.`,
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#moving-from-buildconfigts',
  },
  NUXT_MB_D0102: {
    why: 'The `unbuild` field of `package.json` is deprecated. Its options are still applied.',
    fix: 'Rename the field to `build`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#build-configuration',
  },
  NUXT_MB_D0103: {
    why: (p: { hook: string }): string => `Ignoring ${p.hook}: runtime files are no longer built with mkdist.`,
    fix: 'Remove the hook.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#hooks',
  },
  NUXT_MB_D0104: {
    why: (p: { paths: string[] }): string => `\`@nuxt/module-builder\` no longer generates \`.d.ts\` declarations for the module entry, which these \`package.json\` paths point at: ${list(p.paths)}.`,
    fix: 'Replace `.d.ts` with `.d.mts` in each of them.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#declaration-paths',
  },
  NUXT_MB_D0105: {
    why: '`@nuxt/module-builder` no longer generates `module.cjs`, which Nuxt 3 and later do not need.',
    fix: 'Replace it with `./dist/module.mjs` in `package.json`.',
    docs: 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md#modulecjs',
  },
} as const

/**
 * Styles the parts of a diagnostic for a terminal stream: a dim code, arrows and labels, inline code
 * in cyan in place of its backticks, and cyan links. The files that `sources` name in a `why` or
 * `fix`, the URLs in it and the docs link are clickable where the terminal supports it. Without
 * colours, inline code keeps its backticks.
 */
function terminalStyle(stream: NodeJS.WriteStream): Style {
  const colours = styleText('cyan', 'x', { stream }) !== 'x'
  const cyan = (text: string) => styleText('cyan', text, { stream })
  return {
    dim: text => styleText('dim', text, { stream }),
    text(text, sources) {
      const links: string[] = []
      const hold = (linked: string) => `\0${links.push(linked) - 1}\0`
      for (const source of sources) {
        const label = labelIn(text, source)
        const { file, line, column } = parseSource(source)
        if (label && existsSync(file)) {
          text = text.replace(new RegExp(`${BEFORE_PATH}${escapeRegExp(label)}${AFTER_PATH}`, 'g'), () => hold(linkPath(file, { line, column, formatter: () => label, stream })))
        }
      }
      text = text.replace(URL_RE, url => hold(hyperlink(cyan(url), url, { stream })))
      if (colours) {
        text = text.replace(INLINE_CODE_RE, (_, code: string) => cyan(code))
      }
      return text.replace(/\0(\d+)\0/g, (_, index: string) => links[Number(index)]!)
    },
    link: url => hyperlink(cyan(url), url, { stream }),
  }
}

const INLINE_CODE_RE = /`([^`\n]+)`/g
const URL_RE = /https?:\/\/[^\s`'"()]*[^\s`'"().,;:]/g
const SOURCE_RE = /^(.*?)(?::(\d+)(?::(\d+))?)?$/
const BEFORE_PATH = '(?<=^|[\\s`\'"(])'
const AFTER_PATH = '(?=$|[\\s`\'"),:;.])'

function parseSource(source: string) {
  const [, file, line, column] = source.match(SOURCE_RE)!
  return { file: file!, line: line ? Number(line) : undefined, column: column ? Number(column) : undefined }
}

/**
 * The text that names `source`, a `file:line:column`, in `text`: the longest trailing part of
 * its path, possibly after `./` or `../` segments, followed by its position as `:line:column` or
 * `(line,column)`, or by nothing.
 */
function labelIn(text: string, source: string): string | undefined {
  const { file, line, column } = parseSource(source)
  const positions = [
    ...line !== undefined && column !== undefined ? [`:${line}:${column}`, `(${line},${column})`] : [],
    ...line !== undefined && column === undefined ? [`:${line}`] : [],
    '',
  ]
  const segments = file.split('/')
  for (let index = 0; index < segments.length; index++) {
    const path = segments.slice(index).join('/')
    for (const position of path ? positions : []) {
      const found = text.match(new RegExp(`${BEFORE_PATH}${index ? '(?:\\.\\.?/)*' : ''}${escapeRegExp(path + position)}${AFTER_PATH}`))
      if (found) {
        return found[0]
      }
    }
  }
}

interface Style {
  dim: (text: string) => string
  /** Styles a `why` or `fix`, in which `sources` may be named. */
  text: (text: string, sources: string[]) => string
  link: (url: string) => string
}

const PLAIN: Style = { dim: text => text, text: text => text, link: url => url }

/** The `fix` and docs lines that follow the code and `why` of a diagnostic, as a tree. */
function details(diagnostic: Diagnostic<unknown>, style: Style = PLAIN): string[] {
  const items = [
    ...diagnostic.fix ? [`${style.dim('fix:')} ${style.text(diagnostic.fix, diagnostic.sources ?? [])}`] : [],
    ...diagnostic.docs ? [`${style.dim('see:')} ${style.link(diagnostic.docs)}`] : [],
  ]
  return items.map((item, index) => {
    const last = index === items.length - 1
    const [first, ...rest] = item.split('\n')
    return [
      `${style.dim(last ? '╰▶' : '├▶')} ${first}`,
      ...rest.map(line => last ? `   ${line}`.trimEnd() : `${style.dim('│')}${line && `  ${line}`}`),
    ].join('\n')
  })
}

/** A diagnostic as text: `[CODE] why`, then its `fix` and docs. The `sources` it names are linked. */
export function formatDiagnostic(diagnostic: Diagnostic<unknown>, style: Style = PLAIN): string {
  return [`${style.dim(`[${diagnostic.name}]`)} ${style.text(diagnostic.message, diagnostic.sources ?? [])}`, ...details(diagnostic, style)].join('\n')
}

/**
 * Replaces the stack frames with the `fix` and docs lines, as tsdown and rolldown print the
 * stack of an error rather than its fields, and a diagnostic reports a mistake in the module
 * rather than in the builder.
 */
const withDetailsInStack: DiagnosticReporter = (diagnostic) => {
  diagnostic.stack = [`${diagnostic.name}: ${diagnostic.message}`, ...details(diagnostic)].join('\n')
}

type BuildLogger = Pick<Logger, 'info' | 'warn' | 'error'>

let buildLogger: BuildLogger | undefined

/**
 * Prints diagnostics with the logger of a tsdown build from now on, so its `logLevel`,
 * `failOnWarn` and `suppressWarnings` apply to them.
 */
export function useBuildLogger(logger: BuildLogger): void {
  buildLogger = logger
}

/** Prints a diagnostic with the build's logger, or else `logger`, as a warning unless `method` says otherwise. */
const report: DiagnosticReporter<{ method?: 'info' | 'warn' | 'error' }> = (diagnostic, options) => {
  const method = options?.method ?? 'warn'
  const target = buildLogger ?? logger
  target[method](formatDiagnostic(diagnostic, terminalStyle(method === 'info' ? process.stdout : process.stderr)))
}

/**
 * Prints `error` as an error if it is a diagnostic, or a rolldown build error made of
 * diagnostics, followed by their causes, and returns whether it did.
 */
export function reportFailure(error: unknown): boolean {
  const found = diagnosticsOf(error)
  for (const diagnostic of found) {
    report(diagnostic, { method: 'error' })
    if (diagnostic.cause !== undefined) {
      console.error(diagnostic.cause)
    }
  }
  return found.length > 0
}

/** `error` if it is a diagnostic, or the errors of a rolldown build error when all of them are diagnostics. */
function diagnosticsOf(error: unknown): Diagnostic<unknown>[] {
  const nested = (error as { errors?: unknown } | undefined)?.errors
  return error instanceof Diagnostic ? [error] : Array.isArray(nested) && nested.length && nested.every(item => item instanceof Diagnostic) ? nested as Diagnostic<unknown>[] : []
}

/**
 * The diagnostic of a rolldown build error made of one, with the stack of its cause after its
 * own, or else `error`. tsdown prints the stack of a failed build, and rolldown's frames say
 * nothing about a mistake in the module.
 */
export function unwrapBuildError(error: unknown): unknown {
  const found = diagnosticsOf(error)
  if (found.length !== 1 || found[0] === error) {
    return error
  }
  const [diagnostic] = found as [Diagnostic<unknown>]
  const cause = diagnostic.cause instanceof Error ? diagnostic.cause.stack : undefined
  if (cause) {
    diagnostic.stack = `${diagnostic.stack}\nCaused by: ${cause}`
  }
  return diagnostic
}

/** Diagnostics that are thrown, or handed to rolldown as a log, so they are not printed when created. */
export const errors: Diagnostics<typeof errorCodes, readonly [typeof withDetailsInStack]> = defineDiagnostics({ reporters: [withDetailsInStack], codes: errorCodes })

/** Diagnostics that are printed when created. */
export const warnings: Diagnostics<typeof warningCodes, readonly [typeof report]> = defineDiagnostics({ reporters: [report], codes: warningCodes })
