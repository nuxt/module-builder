#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import type { CommandDef } from 'citty'
import pkg from '../package.json' with { type: 'json' }

const { name, description, version } = pkg

const _rDefault = (r: unknown) => (r && typeof r === 'object' && 'default' in r ? r.default : r) as Promise<CommandDef>

const main = defineCommand({
  meta: {
    name,
    description,
    version,
  },
  subCommands: {
    prepare: () => import('./commands/prepare.ts').then(_rDefault),
    build: () => import('./commands/build.ts').then(_rDefault),
  },
})

runMain(main)
