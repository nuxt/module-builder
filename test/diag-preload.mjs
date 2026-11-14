import { writeFileSync } from 'node:fs'

const started = Date.now()
setInterval(() => {
  process.stderr.write(`[diag] heartbeat +${Date.now() - started}ms resources=${JSON.stringify(process.getActiveResourcesInfo())}\n`)
}, 5000).unref()

setTimeout(() => {
  process.stderr.write(`[diag] writing report +${Date.now() - started}ms\n`)
  if (process.env.DIAG_REPORT) {
    writeFileSync(process.env.DIAG_REPORT, JSON.stringify(process.report.getReport(), null, 2))
  }
}, 45_000).unref()
