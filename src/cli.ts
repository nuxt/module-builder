#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import type { CommandDef } from 'citty'

const _rDefault = (r: any) => (r.default || r) as Promise<CommandDef>

const main = defineCommand({
  meta: {
    name: 'nuxt-module-build',
    description: 'Nuxt Module Builder'
  },
  subCommands: {
    prepare: () => import('./commands/prepare').then(_rDefault),
    build: () => import('./commands/build').then(_rDefault)
  },
  setup (context) {
    // TODO: support 'default command' in citty?
    const firstArg = context.rawArgs[0]
    if (!(firstArg in context.cmd.subCommands)) {
      context.rawArgs.unshift('build')
    }
  }
})

runMain(main)
