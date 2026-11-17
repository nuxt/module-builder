#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import type { CommandDef } from 'citty'
import pkg from '../package.json' with { type: 'json' }
import { reportFailure } from './diagnostics.ts'

const { name, description, version } = pkg

const _rDefault = (r: unknown) => (r && typeof r === 'object' && 'default' in r ? r.default : r) as Promise<CommandDef>

const withDiagnostics = (command: CommandDef): CommandDef => ({
  ...command,
  async run(context) {
    try {
      return await command.run?.(context)
    }
    catch (error) {
      if (!reportFailure(error)) {
        throw error
      }
      await new Promise(resolve => process.stderr.write('', resolve))
      process.exit(1)
    }
  },
})

const main = defineCommand({
  meta: {
    name,
    description,
    version,
  },
  subCommands: {
    prepare: () => import('./commands/prepare.ts').then(_rDefault).then(withDiagnostics),
    build: () => import('./commands/build.ts').then(_rDefault).then(withDiagnostics),
  },
})

runMain(main)
