import { defineConfig } from 'rolldown'
import { dts } from 'rolldown-plugin-dts'
import { globSync } from 'tinyglobby'
import path from 'pathe'

export default defineConfig({
  input: Object.fromEntries(
    globSync('src/**/*.ts').map(file => [
      path.relative('src', file.slice(0, file.length - path.extname(file).length))
        .split(path.sep)
        .join('/'),
      path.resolve(file),
    ]),
  ),
  platform: 'node',
  external: /^[^./]/,
  plugins: [
    dts()
  ],
  output: {
    entryFileNames: '[name].mjs',
  }
})
