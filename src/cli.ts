#!/usr/bin/env node

/* eslint-disable no-console */
import mri from 'mri'
import { resolve } from 'pathe'
import { buildModule } from './build'
import { prepareModule } from './prepare'

// TODO: use citty
function main () {
  const args = mri(process.argv.slice(2))

  if (args._[0] === 'prepare') {
    return prepareModule({
      rootDir: resolve(args._[1] || '.')
    })
  }

  return buildModule({
    rootDir: resolve(args._[0] || '.'),
    outDir: args.outDir,
    stub: args.stub
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
