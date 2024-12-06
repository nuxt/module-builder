import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MODULE_RESOLUTION = process.env.MODULE_RESOLUTION

if (!MODULE_RESOLUTION) {
  throw new Error('MODULE_RESOLUTION should be defined')
}

// Write the .nuxtrc file
writeFileSync('.nuxtrc', `typescript.tsConfig.compilerOptions.moduleResolution=${MODULE_RESOLUTION}\n`)

// Run the commands
execSync('nuxt prepare', { stdio: 'inherit' })
execSync('vue-tsc --noEmit', { stdio: 'inherit' })
