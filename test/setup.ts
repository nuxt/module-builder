import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const slotsDir = fileURLToPath(new URL('../.temp-slots', import.meta.url))

export async function setup() {
  await rm(slotsDir, { recursive: true, force: true })
}

export async function teardown() {
  await rm(slotsDir, { recursive: true, force: true })
}
