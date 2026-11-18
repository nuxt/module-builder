import process from 'node:process'

import { sourcePathsPackError, unpublishablePaths } from '../src/build/package.ts'
import { readPackageJson } from '../src/utils.ts'

const PACK_VARS = /^npm_(?:lifecycle_event|execpath|config_user_agent|command)$/i

/**
 * The environment that `npm pack` gives `prepack` when a pnpm script runs it. Windows matches
 * variable names case-insensitively and passes on the first in sort order, so each one is also
 * set under the names the test runner inherited it with.
 */
export function npmPackFromPnpmScript(): Record<string, string> {
  const vars: Record<string, string> = { npm_lifecycle_event: 'prepack', npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js', npm_config_user_agent: 'pnpm/12.11.2 npm/? node/? linux arm64' }
  const inherited = Object.keys(process.env).filter(key => Object.hasOwn(vars, key.toLowerCase()) && !Object.hasOwn(vars, key))
  return { ...vars, ...Object.fromEntries(inherited.map(key => [key, vars[key.toLowerCase()]!])), MODULE_BUILDER_PACK_PROBE: '1' }
}

/** Node arguments that make the process report the pack variables it reads and the result of the pack check. */
export const packProbeArgs: string[] = ['--import', import.meta.url]

/** The test process and the pack variables it inherited, for an assertion message. */
export function packProbeContext(): string {
  return `[pack-probe] test pid ${process.pid}, inherited ${JSON.stringify(packVars())}`
}

function packVars() {
  return Object.entries(process.env).filter(([key]) => PACK_VARS.test(key))
}

if (process.env.MODULE_BUILDER_PACK_PROBE) {
  delete process.env.MODULE_BUILDER_PACK_PROBE
  const cwd = process.cwd()
  const pkg = await readPackageJson(cwd)
  const report = (when: string, extra: Record<string, unknown> = {}) => process.stderr.write(`[pack-probe] ${when} ${JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    cwd,
    vars: packVars(),
    read: { npm_lifecycle_event: process.env.npm_lifecycle_event, npm_execpath: process.env.npm_execpath, npm_config_user_agent: process.env.npm_config_user_agent },
    ...extra,
  })}\n`)
  report('start', { name: pkg.name, unpublishablePaths: unpublishablePaths(cwd, pkg), packError: sourcePathsPackError(cwd, pkg)?.code ?? null })
  process.on('exit', () => report('exit'))
}
