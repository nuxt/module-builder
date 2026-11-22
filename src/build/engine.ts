import { errors, warnings } from '../diagnostics.ts'
import { ENGINES } from '../transpile/engine.ts'
import type { DeclarationEngine, DeclarationEngineName } from '../transpile/engine.ts'
import { createNativeEngine, hasNativeTypescript, installedNativeEngine, NativeEngineError } from '../transpile/native.ts'
import type { NativeEngineName } from '../transpile/native.ts'
import { isDeclarationEngine } from './options.ts'
import type { ModuleConfig } from './options.ts'

const ENGINE_ENV = 'NUXT_MODULE_BUILDER_DECLARATION_ENGINE'

const INSTALL: Record<NativeEngineName, string> = {
  [ENGINES.typescript]: 'pnpm add -D typescript@beta',
  [ENGINES.typescript7]: 'pnpm add -D @typescript/typescript7@npm:typescript@beta',
  [ENGINES.tsrs]: 'pnpm add -D tsrs',
}

/** The declaration engine `NUXT_MODULE_BUILDER_DECLARATION_ENGINE` or else `declarations.engine` selects, with where it is set, if either does. */
function selectedEngine(config: Pick<ModuleConfig, 'declarationEngine'>): { engine: DeclarationEngineName, setting: string } | undefined {
  const value = process.env[ENGINE_ENV]
  if (value) {
    if (!isDeclarationEngine(value)) {
      throw errors.NUXT_MB_C0403({ value, engines: Object.values(ENGINES) })
    }
    return { engine: value, setting: `\`${ENGINE_ENV}\`` }
  }
  return config.declarationEngine && { engine: config.declarationEngine, setting: '`declarations.engine`' }
}

/** Fails when the module's own `typescript` has no JavaScript API, as TypeScript 7 has none. */
export async function assertSupportedTypescript(): Promise<void> {
  const ts = (await import('typescript')).default as Partial<typeof import('typescript')> & { version: string }
  if (typeof ts.createProgram !== 'function') {
    throw errors.NUXT_MB_B0005({ version: ts.version, install: INSTALL[ENGINES.typescript7] })
  }
}

const warned = new Set<string>()

/**
 * The native declaration engine to use, or `undefined` for the JavaScript API of the module's own
 * TypeScript. Without a selection, it is the one the module has installed, see
 * `installedNativeEngine`. `typescript` is native when the module's own `typescript` is 7.1 or
 * later. A selected engine that is not installed, or too old, fails with a diagnostic. An engine
 * that cannot be used otherwise is replaced by the JavaScript API, with a warning once per process.
 */
export async function loadDeclarationEngine(cwd: string, config: Pick<ModuleConfig, 'declarationEngine'>): Promise<DeclarationEngine | undefined> {
  const selected = selectedEngine(config)
  const engine = selected?.engine ?? installedNativeEngine(cwd)
  if (!engine || (engine === ENGINES.typescript && !hasNativeTypescript(cwd))) {
    return
  }
  try {
    return await createNativeEngine(cwd, engine)
  }
  catch (error) {
    if (!(error instanceof NativeEngineError)) {
      throw error
    }
    const { setting } = selected ?? {}
    if (setting && error.reason === 'missing') {
      throw errors.NUXT_MB_C0401({ engine, setting, install: INSTALL[engine], fallback: ENGINES.typescript, cause: error })
    }
    if (setting && error.reason === 'version') {
      throw errors.NUXT_MB_C0402({ engine, name: error.installedAs, found: error.found ?? error.installedAs, install: INSTALL[engine], cause: error })
    }
    if (!warned.has(engine)) {
      warned.add(engine)
      warnings.NUXT_MB_C0404({ engine, reason: error.message.replace(/\.$/, '') })
    }
  }
}
