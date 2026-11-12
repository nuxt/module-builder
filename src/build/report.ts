import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { join, relative } from 'pathe'
import { consola } from 'consola'
import { glob } from 'tinyglobby'
import type { RolldownChunk } from 'tsdown'

import type { DirectoryEntry } from './build-config.ts'

const gzipAsync = promisify(gzip)
const DECLARATION_RE = /\.d\.(?:[cm]?ts|vue\.ts)$/

const originalStdoutWrite = process.stdout.write.bind(process.stdout)
let outputRedirected = false

interface SizeBreakdown {
  code: number
  types: number
  gzip: number
}

export interface BuildSizeReport extends SizeBreakdown {
  total: number
  entries: Record<string, SizeBreakdown>
  directories: Record<string, SizeBreakdown>
  other: SizeBreakdown
}

export interface ReportSizeOptions {
  cwd: string
  outDir: string
  /** Bundled entry output names, such as `module` and `utils`. */
  entries: string[]
  directories: DirectoryEntry[]
  /** The bundled chunks tsdown returned, used for the entries' exports. */
  chunks: RolldownChunk[]
  /** Print the report as JSON to stdout instead of the human summary. */
  json?: boolean
}

interface SizedFile {
  size: number
  gzip: number
}

/** Counts the files written to `outDir`, and prints the summary or the JSON report. */
export async function reportSize({ cwd, outDir, entries, directories, chunks, json = false }: ReportSizeOptions): Promise<BuildSizeReport> {
  const files = await glob(['**/*'], { cwd: outDir, absolute: true, onlyFiles: true, dot: true })
  const sizedFiles = await Promise.all(files.map(async (file) => {
    const path = relative(outDir, file)
    if (path === 'module.json') {
      return
    }
    const size = (await stat(file)).size
    const gzipSize = isDeclaration(path) ? 0 : (await gzipAsync(await readFile(file))).length
    return { path, size, gzip: gzipSize } as const
  }))
  const sizes = new Map<string, SizedFile>()
  for (const file of sizedFiles) {
    if (file) {
      sizes.set(file.path, { size: file.size, gzip: file.gzip })
    }
  }

  const report = buildSizeReport(outDir, entries, directories, sizes)
  if (json) {
    originalStdoutWrite(`${JSON.stringify(report)}\n`)
  }
  else {
    printSizeReport(cwd, outDir, entries, directories, chunks, report, sizes)
  }
  return report
}

/** Send consola and `console` output to stderr so stdout carries only the JSON report. */
export function redirectLogsToStderr(): void {
  if (outputRedirected) {
    return
  }
  outputRedirected = true
  consola.options.stdout = process.stderr
  consola.options.stderr = process.stderr
  consola.wrapConsole()
  process.stdout.write = ((chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback)) as typeof process.stdout.write
}

function buildSizeReport(outDir: string, entries: string[], directories: DirectoryEntry[], sizes: Map<string, SizedFile>): BuildSizeReport {
  const claimed = new Set<string>()
  const entryBreakdowns: Record<string, SizeBreakdown> = {}
  for (const name of sortEntryNames(entries)) {
    claimed.add(`${name}.mjs`)
    claimed.add(`${name}.d.mts`)
    let types = sizes.get(`${name}.d.mts`)?.size ?? 0
    if (name === 'module') {
      claimed.add('types.d.mts')
      types += sizes.get('types.d.mts')?.size ?? 0
    }
    entryBreakdowns[name] = {
      code: sizes.get(`${name}.mjs`)?.size ?? 0,
      types,
      gzip: sizes.get(`${name}.mjs`)?.gzip ?? 0,
    }
  }

  const directoryBreakdowns: Record<string, SizeBreakdown> = {}
  const directoryNames = [...new Set(directories.map(directory => relative(outDir, directory.outDir) || '.'))]
    .sort((a, b) => directoryDepth(b) - directoryDepth(a) || a.localeCompare(b))
  for (const name of directoryNames) {
    const prefix = name === '.' ? '' : `${name}/`
    const breakdown: SizeBreakdown = { code: 0, types: 0, gzip: 0 }
    for (const [path, file] of sizes) {
      if (claimed.has(path) || (prefix !== '' && !path.startsWith(prefix))) {
        continue
      }
      claimed.add(path)
      if (isDeclaration(path)) {
        breakdown.types += file.size
      }
      else {
        breakdown.code += file.size
        breakdown.gzip += file.gzip
      }
    }
    if (breakdown.code || breakdown.types) {
      directoryBreakdowns[name] = breakdown
    }
  }

  const other: SizeBreakdown = { code: 0, types: 0, gzip: 0 }
  for (const [path, file] of sizes) {
    if (claimed.has(path)) {
      continue
    }
    if (isDeclaration(path)) {
      other.types += file.size
    }
    else {
      other.code += file.size
      other.gzip += file.gzip
    }
  }

  const sum = (field: (sizes: SizeBreakdown) => number) => Object.values(entryBreakdowns).reduce((total, entry) => total + field(entry), 0)
    + Object.values(directoryBreakdowns).reduce((total, directory) => total + field(directory), 0) + field(other)

  const code = sum(sizes => sizes.code)
  const types = sum(sizes => sizes.types)

  return {
    code,
    types,
    gzip: sum(sizes => sizes.gzip),
    total: code + types,
    entries: entryBreakdowns,
    directories: directoryBreakdowns,
    other,
  }
}

function printSizeReport(cwd: string, outDir: string, entries: string[], directories: DirectoryEntry[], chunks: RolldownChunk[], report: BuildSizeReport, sizes: Map<string, SizedFile>) {
  const chunksByFile = new Map<string, Extract<RolldownChunk, { type: 'chunk' }>>()
  for (const chunk of chunks) {
    if (chunk.type === 'chunk') {
      chunksByFile.set(chunk.fileName, chunk)
    }
  }

  interface Row { label: string, details: string, contributions: string[] }
  const rows: Row[] = []

  for (const name of sortEntryNames(entries)) {
    const breakdown = report.entries[name]!
    const exports = chunksByFile.get(`${name}.mjs`)?.exports.join(', ') || ''
    rows.push({
      label: relative(cwd, join(outDir, `${name}.mjs`)),
      details: breakdownText(breakdown, exports && `exports: ${exports}`),
      contributions: [],
    })
  }

  const entryFiles = new Set(sortEntryNames(entries).flatMap(name => [`${name}.mjs`, `${name}.d.mts`]).concat('types.d.mts'))
  const directoryKeys = sortDirectoryNames(directories, outDir).filter(name => report.directories[name])
  for (const name of directoryKeys) {
    const breakdown = report.directories[name]!
    const prefix = name === '.' ? '' : `${name}/`
    const nested = directoryKeys.filter(other => other !== name && other.startsWith(prefix)).map(other => `${other}/`)
    const codeFiles = [...sizes]
      .filter(([path]) => !entryFiles.has(path) && !isDeclaration(path)
        && (prefix === '' || path.startsWith(prefix))
        && !nested.some(child => path.startsWith(child)))
      .sort((a, b) => b[1].size - a[1].size)
    const contributions = codeFiles.length > 3 ? codeFiles.slice(0, 3).map(([path]) => `${formatBytes(sizes.get(path)!.size)}  ${path.slice(prefix.length)}`) : []
    rows.push({
      label: relative(cwd, name === '.' ? outDir : join(outDir, name)),
      details: breakdownText(breakdown, `${codeFiles.length} files`),
      contributions,
    })
  }

  if (report.other.code || report.other.types) {
    rows.push({ label: 'other', details: breakdownText(report.other), contributions: [] })
  }

  const labelWidth = Math.max(...rows.map(row => row.label.length), 'Total'.length)
  const lines = rows.flatMap((row) => {
    const own = `  ${row.label.padEnd(labelWidth)}  ${row.details}`
    if (!row.contributions.length) {
      return [own]
    }
    return [own, ...row.contributions.map((contribution, index) => {
      const connector = index === row.contributions.length - 1 ? '└─' : '├─'
      return `    ${connector} ${contribution}`
    })]
  })

  const total = `${formatBytes(report.total)} · ${formatBytes(report.code)} code · ${formatBytes(report.types)} types · gzip ${formatBytes(report.gzip)}`
  lines.push('', `  ${'Total'.padEnd(labelWidth)}  ${total}`)
  consola.info(`Size report:\n\n${lines.join('\n')}`)
}

function breakdownText(sizes: SizeBreakdown, extra?: string) {
  const parts = [
    `${formatBytes(sizes.code)} code`,
    `${formatBytes(sizes.types)} types`,
    `gzip ${formatBytes(sizes.gzip)}`,
  ]
  if (extra) {
    parts.push(extra)
  }
  return parts.join(' · ')
}

function sortEntryNames(entries: string[]) {
  return [...entries].sort((a, b) => a === 'module' ? -1 : b === 'module' ? 1 : a.localeCompare(b))
}

function sortDirectoryNames(directories: DirectoryEntry[], outDir: string) {
  return [...new Set(directories.map(directory => relative(outDir, directory.outDir) || '.'))]
    .sort((a, b) => a === 'runtime' ? -1 : b === 'runtime' ? 1 : a.localeCompare(b))
}

function isDeclaration(path: string) {
  return DECLARATION_RE.test(path)
}

function directoryDepth(name: string) {
  return name === '.' ? 0 : name.split('/').length
}

function formatBytes(bytes: number) {
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(2)} MB`
  }
  if (bytes >= 1e3) {
    return `${(bytes / 1e3).toFixed(2)} kB`
  }
  return `${bytes} B`
}
