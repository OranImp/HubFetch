import { defineConfig } from 'i18next-cli'

export default defineConfig({
  locales: ['en', 'zh-CN'],
  extract: {
    input: ['src/renderer/src/**/*.{ts,tsx}'],
    output: 'src/renderer/src/i18n/locales/{{language}}/{{namespace}}.json',
    defaultNS: 'common',
    keySeparator: '.',
    nsSeparator: ':',
    removeUnusedKeys: false,
    disablePlurals: true,
    preservePatterns: [
      'profile:empty.*',
      'profile:stats.*',
      'upload:warnings.*',
      'upload:phase.*',
      'common:kind.*',
      'inbox:kind.*',
      'clones:proxy.*',
      'clones:phase.*',
      'clones:transport.*',
      'clones:status.*',
      'clones:statusHint.*',
      'downloads:proxyModes.*',
      'downloads:status.*',
      'diagnostics:category.*',
      'diagnostics:status.*',
      'admin:myRepos.filter.*',
      'admin:space.runtime.stage.*'
    ]
  }
})
