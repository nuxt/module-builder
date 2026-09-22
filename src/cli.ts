#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import type { CommandDef } from 'citty'
import { consola } from 'consola'
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
  setup(context) {
    // TODO: support 'default command' in citty?
    const firstArg = context.rawArgs[0]
    if (context.cmd.subCommands && !(firstArg && firstArg in context.cmd.subCommands)) {
      consola.warn('Please specify the `build` command explicitly. In a future version of `@nuxt/module-builder`, the implicit default build command will be removed.')
      context.rawArgs.unshift('build')
    }
  },
})

runMain(main)
