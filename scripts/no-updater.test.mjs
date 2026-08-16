// Negative policy test for the removed self-update capability (plan Todo 16).
//
// Scans the app's production source, lockfile, built main/preload/renderer
// bundles, and electron-builder config for any trace of:
//   - the electron-updater package (dependency / import / external config)
//   - update check / download / install / restart operations
//   - updater IPC channels and events
//   - updater state contracts (AppUpdateState / UpdateManager)
//   - release-feed metadata (publish block, latest*.yml, app-update.yml, blockmap)
//
// Anything found outside the intentionally-exempt release-tools scripts and
// docs is a violation. A companion test feeds the scanner a disposable fixture
// carrying a dynamic `import('electron-updater')` and one stale IPC channel and
// requires it to be detected.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Relative roots that must stay updater-free. Release tooling under
// .github/scripts and documentation are intentionally excluded: they explain
// the absence or pre-date the removal and are reworked by later plan todos.
const SCAN_TARGETS = [
  'apps/desktop/src',
  'packages/shared/src',
  'apps/desktop/electron.vite.config.ts',
  'apps/desktop/electron-builder.yml',
  'apps/desktop/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'apps/desktop/out'
]

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml)$/

// Patterns are assembled from fragments so this file's own fixture literals
// cannot self-match during the repo scan.
const UPDATER_STRINGS = [
  ['electron', '-updater'],
  ['checkFor', 'Updates'],
  ['download', 'Update'],
  ['quit', 'AndInstall'],
  ['updater', ':getState'],
  ['updater', ':check'],
  ['updater', ':download'],
  ['updater', ':install'],
  ['evt', ':updater'],
  ['App', 'Update', 'State'],
  ['Update', 'Manager'],
  ['latest', '.yml'],
  ['latest-mac', '.yml'],
  ['latest-linux', '.yml'],
  ['app-update', '.yml'],
  ['block', 'map']
].map((parts) => parts.join(''))

/** Files to scan under a root, mirroring SCAN_TARGETS shape for fixtures. */
function collectFiles(root, targets) {
  const files = []
  for (const target of targets) {
    const abs = join(root, target)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) {
      walk(abs, (file) => {
        if (SOURCE_EXT.test(file)) files.push(file)
      })
    } else {
      files.push(abs)
    }
  }
  return files
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

/**
 * Scans `root` and returns a list of `rel: contains "pattern"` violations.
 * Lockfiles are only checked for the electron-updater package entry.
 */
export function scanForUpdater(root = repositoryRoot) {
  const targets = existsSync(join(root, 'apps'))
    ? SCAN_TARGETS
    : [
        'apps/desktop/src',
        'packages/shared/src',
        'pnpm-lock.yaml',
        'apps/desktop/electron-builder.yml'
      ]
  const violations = []
  for (const file of collectFiles(root, targets)) {
    const rel = relative(root, file)
    const base = file.split(/[\\/]/).pop()
    const content = readFileSync(file, 'utf8')
    const patterns =
      base === 'pnpm-lock.yaml'
        ? ['electron-updater']
        : base === 'electron-builder.yml'
          ? [...UPDATER_STRINGS, 'publish:']
          : base === 'package.json'
            ? [...UPDATER_STRINGS, 'publish']
            : UPDATER_STRINGS
    for (const pattern of patterns) {
      if (content.includes(pattern)) {
        violations.push(`${rel}: contains "${pattern}"`)
      }
    }
  }
  return violations
}

test('no updater traces remain in source, lockfile, bundles, or builder config', () => {
  const violations = scanForUpdater()
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('negative fixture: dynamic electron-updater import and stale IPC channel are detected', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-no-updater-fixture-'))
  const fixtureApps = join(fixture, 'apps/desktop')
  mkdirSync(join(fixtureApps, 'src/main'), { recursive: true })
  mkdirSync(join(fixture, 'packages/shared/src'), { recursive: true })
  writeFileSync(
    join(fixture, 'pnpm-lock.yaml'),
    'lockfileVersion: "9.0"\npackages:\n  electron-updater@6.8.9:\n    resolution: {integrity: sha512-fake}\n'
  )
  writeFileSync(
    join(fixtureApps, 'electron-builder.yml'),
    'appId: io.github.oranimp.hubfetch\npublish:\n  provider: github\n  owner: OranImp\n  repo: HubFetch\n'
  )
  writeFileSync(
    join(fixtureApps, 'src/main/evil.ts'),
    "export async function load() {\n  const updater = await import('electron-updater')\n  return updater.autoUpdater.checkForUpdates()\n}\n"
  )
  writeFileSync(
    join(fixture, 'packages/shared/src/ipc.ts'),
    "export const IPC_INVOKE_CHANNELS = ['updater:getState', 'hub:search'] as const\n"
  )
  const violations = scanForUpdater(fixture)
  const joined = violations.join('\n')
  assert.ok(violations.length >= 4, `expected fixture to trip scanner, got:\n${joined}`)
  assert.match(joined, /electron-updater/)
  assert.match(joined, /checkForUpdates/)
  assert.match(joined, /updater:getState/)
  assert.match(joined, /publish:/)
})
