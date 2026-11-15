import { readFile, writeFile } from 'node:fs/promises'

/** Writes `contents` to `file` unless it already holds them, so its modification time only changes with its content. */
export async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, 'utf8').catch(() => undefined) !== contents) {
    await writeFile(file, contents, 'utf8')
  }
}
