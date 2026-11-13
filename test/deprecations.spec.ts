import { fileURLToPath } from 'node:url'
import { join } from 'pathe'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function deprecations(source: string) {
  const file = join(repoRoot, 'test/__deprecations__.ts')
  const options: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2024,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  }
  const service = ts.createLanguageService({
    getScriptFileNames: () => [file],
    getScriptVersion: () => '1',
    getScriptSnapshot: name => name === file ? ts.ScriptSnapshot.fromString(source) : ts.sys.fileExists(name) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(name)!) : undefined,
    getCurrentDirectory: () => repoRoot,
    getCompilationSettings: () => options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: name => name === file || ts.sys.fileExists(name),
    readFile: name => name === file ? source : ts.sys.readFile(name),
  })
  expect(service.getSemanticDiagnostics(file).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  return service.getSuggestionDiagnostics(file)
    .filter(diagnostic => diagnostic.reportsDeprecated)
    .map(diagnostic => ({
      name: source.slice(diagnostic.start, diagnostic.start! + diagnostic.length!),
      advice: ts.displayPartsToString(service.getQuickInfoAtPosition(file, diagnostic.start!)?.tags?.find(tag => tag.name === 'deprecated')?.text),
    }))
}

describe('deprecations in the editor', () => {
  it('should mark `defineBuildConfig()`', () => {
    expect(deprecations([
      `import { defineBuildConfig } from '../src/index.ts'`,
      `defineBuildConfig({ entries: ['./src/utils'] })`,
    ].join('\n'))).toEqual(Array.from({ length: 2 }, () => ({
      name: 'defineBuildConfig',
      advice: expect.stringMatching(/`builder\(\)` from `@nuxt\/module-builder\/tsdown`, in `tsdown\.config\.ts`/),
    })))
  })
})
