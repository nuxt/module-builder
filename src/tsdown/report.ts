import { relative } from 'pathe'
import type { Rolldown, UserConfig } from 'tsdown'

import type { DirectoryEntry } from '../build/build-config.ts'

const DECLARATION_RE = /\.d\.(?:[^/]+\.)?[cm]?ts$/

/**
 * tsdown's size report, unless the config sets `report`: a summary when the build has
 * runtime directories, whose files would otherwise get a line each, or the full listing.
 */
export function defaultReport(report: UserConfig['report'], hasDirectories: boolean): UserConfig['report'] {
  return report ?? (hasDirectories ? { summary: true } : true)
}

/** Whether the resolved report only prints a summary, which the breakdown complements. */
export function reportsSummary(report: unknown): boolean {
  return !!report && typeof report === 'object' && (report as { summary?: boolean }).summary === true
}

export interface BreakdownOptions {
  cwd: string
  outDir: string
  /** Bundled entries keyed by output name. */
  entries: Record<string, string>
  directories: DirectoryEntry[]
}

/** One line per bundled entry and per transpiled directory: the size of its code and of its declarations. */
export function sizeBreakdown(bundle: Rolldown.OutputBundle, { cwd, outDir, entries, directories }: BreakdownOptions): string[] {
  const sizes = Object.values(bundle)
    .filter(output => !output.fileName.endsWith('.map'))
    .map(output => ({ fileName: output.fileName, asset: output.type === 'asset', size: Buffer.byteLength(output.type === 'chunk' ? output.code : output.source) }))
  const sizeOf = (fileName: string) => sizes.find(output => output.fileName === fileName)?.size
  const base = relative(cwd, outDir)
  const rows: Array<[label: string, details: string]> = []
  for (const name of Object.keys(entries)) {
    const code = sizeOf(`${name}.mjs`)
    if (code !== undefined) {
      const types = sizeOf(`${name}.d.mts`)
      rows.push([`${base}/${name}.mjs`, [formatSize(code), ...types === undefined ? [] : [`types ${formatSize(types)}`]].join(' · ')])
    }
  }
  const entryFiles = new Set(Object.keys(entries).flatMap(name => [`${name}.mjs`, `${name}.d.mts`]))
  const prefixes = directories.map(directory => relative(outDir, directory.outDir)).map(path => path && `${path}/`)
  const owner = (fileName: string) => prefixes.filter(prefix => fileName.startsWith(prefix)).sort((a, b) => b.length - a.length)[0]
  for (const prefix of prefixes) {
    const files = sizes.filter(output => output.asset && !entryFiles.has(output.fileName) && owner(output.fileName) === prefix)
    if (files.length) {
      const total = (declarations: boolean) => files.filter(output => DECLARATION_RE.test(output.fileName) === declarations).reduce((sum, output) => sum + output.size, 0)
      rows.push([`${base}/${prefix}`, `${formatSize(total(false))} · types ${formatSize(total(true))} · ${files.length} files`])
    }
  }
  const width = Math.max(0, ...rows.map(([label]) => label.length))
  return rows.map(([label, details]) => `${label.padEnd(width)}  ${details}`)
}

function formatSize(bytes: number) {
  return bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(2)} kB` : `${(bytes / 1_000_000).toFixed(2)} MB`
}
