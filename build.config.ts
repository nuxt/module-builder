import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  declaration: true,
  rollup: {
    emitCJS: false
  },
  entries: [
    './src/cli',
    './src/index'
  ]
})
