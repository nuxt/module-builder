const shown = new Set<string>()

/** Advice is shown at most once per process, and never in CI. */
export function shouldAdvise(key: string): boolean {
  if (process.env.CI || shown.has(key)) {
    return false
  }
  shown.add(key)
  return true
}
