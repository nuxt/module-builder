#!/usr/bin/env node

/* eslint-disable no-console */
import mri from 'mri'
import { resolve } from 'pathe'
import { buildModule } from './build'

async function main () {
  const args = mri(process.argv.slice(2))
  const rootDir = resolve(args._[0] || '.')
  await buildModule({
    rootDir,
    stub: args.stub
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
