const GUIDE_URL = 'https://github.com/nuxt/module-builder/blob/main/docs/upgrade-v2.md'

/** The sections of the upgrade guide that build messages link to, by heading anchor. */
export const GUIDE_SECTIONS = [
  'node-engines',
  'install-tsdown',
  'build-configuration',
  'tsdown-config',
  'options-builder-sets',
  'hooks-in-a-tsdown-config',
  'moving-from-buildconfigts',
  'unsupported-build-options',
  'hooks',
  'rollup-options',
  'commonjs-output',
  'mkdist-options',
  'other-options',
  'declaration-paths',
  'modulecjs',
  'the-types-field',
  'paths-the-build-does-not-produce',
  'typesversions-paths',
  'stub-builds',
  'declaration-errors',
  'portability-errors',
  'other-type-errors',
  'isolated-declarations',
  'preparing-nuxt',
  'module-tsconfig',
  'output-directory',
  'publishing-source-exports',
  'module-code-loads-with-node',
] as const

export type GuideSection = typeof GUIDE_SECTIONS[number]

/** The URL of a section of the upgrade guide. */
export function guide(section: GuideSection) {
  return `${GUIDE_URL}#${section}`
}
