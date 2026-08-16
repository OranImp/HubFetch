import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const toolsDirectory = join(repositoryRoot, '.github/scripts/release-tools')

function asset(name, contents) {
  return {
    name,
    size: Buffer.byteLength(contents),
    sha512: createHash('sha512').update(contents).digest('base64')
  }
}

test('verify-assets rejects Windows path separators in manifest names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ohmyhf-release-path-'))
  const name = '..\\evil.exe'
  const contents = 'unsafe'
  writeFileSync(join(directory, name), contents)
  const manifestPath = join(directory, 'release-assets.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, version: '1.2.3', assets: [asset(name, contents)] })
  )

  const result = spawnSync(
    process.execPath,
    [join(toolsDirectory, 'verify-assets.mjs'), manifestPath, directory],
    { encoding: 'utf8' }
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /invalid entry/)
})

test('publish refuses a stale draft target before any remote mutation', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ohmyhf-release-draft-'))
  const assetDirectory = join(fixture, 'assets')
  const binDirectory = join(fixture, 'bin')
  const runnerTemp = join(fixture, 'runner')
  const effectsFile = join(fixture, 'effects.log')
  for (const directory of [assetDirectory, binDirectory, runnerTemp]) {
    mkdirSync(directory, { recursive: true })
  }

  const name = 'app.zip'
  const contents = 'verified asset'
  writeFileSync(join(assetDirectory, name), contents)
  const manifestPath = join(assetDirectory, 'release-assets.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, version: '1.2.3', assets: [asset(name, contents)] })
  )

  const gitPath = join(binDirectory, 'git')
  writeFileSync(gitPath, '#!/bin/sh\nif [ "$1" = "ls-remote" ]; then exit 2; fi\nexit 97\n')
  chmodSync(gitPath, 0o755)

  const oldCommit = '0'.repeat(40)
  const ghPath = join(binDirectory, 'gh')
  writeFileSync(
    ghPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$EFFECTS_FILE"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"isDraft":true,"targetCommitish":"${oldCommit}","url":"https://example.invalid"}'
  exit 0
fi
exit 96
`
  )
  chmodSync(ghPath, 0o755)

  const commit = 'a'.repeat(40)
  const result = spawnSync(
    'bash',
    [join(toolsDirectory, 'publish-release.sh'), '1.2.3', commit, assetDirectory, manifestPath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH}`,
        EFFECTS_FILE: effectsFile,
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_RUN_ID: '123',
        RUNNER_TEMP: runnerTemp
      }
    }
  )

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /targets .* not/)
  const effects = readFileSync(effectsFile, 'utf8')
  assert.match(effects, /release view/)
  assert.doesNotMatch(effects, /release create|release upload|DELETE|draft=false/)
})

test('a fresh draft creates and verifies its tag only after remote assets pass', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ohmyhf-release-fresh-'))
  const assetDirectory = join(fixture, 'assets')
  const binDirectory = join(fixture, 'bin')
  const runnerTemp = join(fixture, 'runner')
  const effectsFile = join(fixture, 'effects.log')
  for (const directory of [assetDirectory, binDirectory, runnerTemp]) {
    mkdirSync(directory, { recursive: true })
  }

  const name = 'app.zip'
  const contents = 'fresh verified asset'
  const assetPath = join(assetDirectory, name)
  writeFileSync(assetPath, contents)
  const manifestPath = join(assetDirectory, 'release-assets.json')
  writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, version: '1.2.3', assets: [asset(name, contents)] })
  )

  const commit = 'b'.repeat(40)
  const gitPath = join(binDirectory, 'git')
  writeFileSync(
    gitPath,
    `#!/bin/sh
printf 'git %s\\n' "$*" >> "$EFFECTS_FILE"
case "$1" in
  ls-remote) exit 2 ;;
  describe) exit 1 ;;
  log) printf '%s\\n' '- verified change (abc1234)'; exit 0 ;;
  push) exit 0 ;;
  fetch) exit 0 ;;
  rev-list) printf '%s\\n' '${commit}'; exit 0 ;;
esac
exit 95
`
  )
  chmodSync(gitPath, 0o755)

  // A fresh draft's tag is not a resolvable git ref until publish, so
  // `gh release view` must work by release name both before AND right after
  // `gh release create` (publish-release.sh looks the id up again post-create
  // to address asset listing/deletion by numeric id instead of by tag, since
  // the tag-scoped REST endpoint 404s until the ref exists). This mock tracks
  // creation with a marker file so "view" only succeeds once "create" ran,
  // matching real gh behavior.
  const createdMarker = join(fixture, 'created')
  const ghPath = join(binDirectory, 'gh')
  writeFileSync(
    ghPath,
    `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$EFFECTS_FILE"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ -f "$CREATED_MARKER" ]; then
    printf '%s\\n' '{"databaseId":999}'
    exit 0
  fi
  exit 1
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then touch "$CREATED_MARKER"; exit 0; fi
if [ "$1" = "api" ]; then exit 0; fi
if [ "$1" = "release" ] && [ "$2" = "upload" ]; then exit 0; fi
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  copy_next=0
  for arg in "$@"; do
    if [ "$copy_next" = "1" ]; then
      mkdir -p "$arg"
      cp "$ASSET_SOURCE" "$arg/app.zip"
      break
    fi
    if [ "$arg" = "--dir" ]; then copy_next=1; fi
  done
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "edit" ]; then exit 0; fi
exit 94
`
  )
  chmodSync(ghPath, 0o755)

  const result = spawnSync(
    'bash',
    [join(toolsDirectory, 'publish-release.sh'), '1.2.3', commit, assetDirectory, manifestPath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH}`,
        ASSET_SOURCE: assetPath,
        CREATED_MARKER: createdMarker,
        EFFECTS_FILE: effectsFile,
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_RUN_ID: '456',
        RUNNER_TEMP: runnerTemp
      }
    }
  )

  assert.equal(result.status, 0, result.stderr)
  const effects = readFileSync(effectsFile, 'utf8')
  const upload = effects.indexOf('gh release upload')
  const push = effects.indexOf('git push')
  const publish = effects.indexOf('gh release edit')
  assert.ok(upload >= 0 && push > upload && publish > push, effects)
  assert.match(effects, /git fetch/)
  assert.match(effects, /git rev-list/)
  // The asset-listing/deletion step must address the release by numeric id
  // (resolved via a second `release view` after `create`), never by the tag
  // name — that REST endpoint 404s until the tag ref exists at publish time.
  assert.match(effects, /gh api repos\/owner\/repo\/releases\/999\/assets/)
})

// ============================================================================
// HubFetch identity contract (plan Todo 12): four 0.2.0 manifests, exact
// package names, private:true, electron-builder appId/productName/repository,
// and no upstream identifiers outside license/provenance/test-negative fixtures
// nor stale internal workspace imports.
// ============================================================================

const MANIFEST_PATHS = [
  ['root', 'package.json'],
  ['desktop', 'apps/desktop/package.json'],
  ['shared', 'packages/shared/package.json'],
  ['hub-api', 'packages/hub-api/package.json']
]

const EXPECTED_NAMES = {
  root: 'hubfetch',
  desktop: 'hubfetch-desktop',
  shared: '@hubfetch/shared',
  'hub-api': '@hubfetch/hub-api'
}

// Upstream identifiers are constructed from parts so the stale-import scanner
// below cannot self-match the literal strings this test defines as fixtures.
const UPSTREAM_IDENTIFIERS = [
  'Oh My HuggingFace',
  `oh-my-${'huggingface'}`,
  `@oh-my-${'huggingface/'}`,
  `dev.oh-my-${'huggingface.desktop'}`,
  'oh-my-hf',
  'github.com/oh-my-hf'
]

function readManifests() {
  const manifests = {}
  for (const [key, rel] of MANIFEST_PATHS) {
    manifests[key] = JSON.parse(readFileSync(join(repositoryRoot, rel), 'utf8'))
  }
  return manifests
}

function identityViolations(manifests) {
  const violations = []
  for (const [key, rel] of MANIFEST_PATHS) {
    const manifest = manifests[key]
    if (!manifest) {
      violations.push(`${rel}: manifest missing`)
      continue
    }
    if (manifest.version !== '0.2.0') {
      violations.push(`${rel}: version=${manifest.version}, expected 0.2.0`)
    }
    if (manifest.name !== EXPECTED_NAMES[key]) {
      violations.push(`${rel}: name=${manifest.name}, expected ${EXPECTED_NAMES[key]}`)
    }
    if (manifest.private !== true) {
      violations.push(`${rel}: private=${manifest.private}, expected true`)
    }
    const serialized = JSON.stringify(manifest)
    for (const id of UPSTREAM_IDENTIFIERS) {
      if (serialized.includes(id)) {
        violations.push(`${rel}: contains upstream identifier "${id}"`)
      }
    }
  }
  return violations
}

test('identity contract: four manifests are 0.2.0 with exact HubFetch names and private:true', () => {
  const violations = identityViolations(readManifests())
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('identity contract: electron-builder appId/productName/repository are HubFetch', () => {
  const builder = readFileSync(join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
  assert.match(builder, /^appId:\s*io\.github\.oranimp\.hubfetch\s*$/m)
  assert.match(builder, /^productName:\s*HubFetch\s*$/m)
  const publishIndex = builder.indexOf('publish:')
  assert.ok(publishIndex >= 0, 'electron-builder publish block present')
  const publishBlock = builder.slice(publishIndex)
  assert.match(publishBlock, /owner:\s*OranImp/)
  assert.match(publishBlock, /repo:\s*HubFetch/)
  assert.equal(readManifests().desktop.homepage, 'https://github.com/OranImp/HubFetch')
})

test('identity contract: no stale internal workspace imports in tracked source', () => {
  const result = spawnSync(
    'git',
    ['grep', '-n', `@oh-my-${'huggingface/'}`, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  assert.equal(result.error, undefined, 'git grep must run')
  assert.equal(result.status, 1, `stale internal imports found:\n${result.stdout}`)
})

test('identity contract negative fixtures: upstream identifiers are rejected', () => {
  const clean = readManifests()
  assert.ok(UPSTREAM_IDENTIFIERS.length > 0)
  for (const id of UPSTREAM_IDENTIFIERS) {
    const dirty = JSON.parse(JSON.stringify(clean))
    dirty.root.description = `fixture bearing ${id}`
    const violations = identityViolations(dirty)
    assert.ok(
      violations.some((v) => v.includes('upstream identifier')),
      `fixture bearing "${id}" must be rejected, got: ${JSON.stringify(violations)}`
    )
  }
})
