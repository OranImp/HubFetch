import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
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

function releaseVersion() {
  return JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version
}

function generatedSbomPath() {
  const version = releaseVersion()
  const path = join(repositoryRoot, 'artifacts/release', `HubFetch-${version}.cdx.json`)
  if (!existsSync(path)) {
    const result = spawnSync(process.execPath, ['scripts/generate-sbom.mjs'], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
  }
  return path
}

function stageReleaseFixture(directory, zipContents) {
  const version = releaseVersion()
  const zipName = `HubFetch-${version}-windows-x64.zip`
  writeFileSync(join(directory, zipName), zipContents)
  copyFileSync(generatedSbomPath(), join(directory, `HubFetch-${version}.cdx.json`))
  const result = spawnSync(
    process.execPath,
    [join(toolsDirectory, 'preflight.mjs'), directory, version],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return { version, zipName, manifestPath: join(directory, 'release-assets.json') }
}

// ============================================================================
// Mock git/gh toolchain (Todo 17): publish-release.mjs is a Node script, so
// these tests no longer spawn bash. On Windows the HUBFETCH_TOOLCHAIN_DIR
// resolution picks up git.cmd/gh.cmd shims that delegate to Node mocks; on
// POSIX hosts it picks up the executable `git`/`gh` shims.
// ============================================================================

const GIT_MOCK = `import { appendFileSync } from 'node:fs'

const effects = process.env.EFFECTS_FILE
const args = process.argv.slice(2)
if (effects) appendFileSync(effects, \`git \${args.join(' ')}\n\`)
switch (args[0]) {
  case 'ls-remote': process.exit(2)
  case 'describe': process.exit(1)
  case 'log': process.stdout.write('- verified change (abc1234)\\n'); process.exit(0)
  case 'push': process.exit(0)
  case 'fetch': process.exit(0)
  case 'rev-list': process.stdout.write(\`\${process.env.GIT_REV_LIST_SHA ?? ''}\\n\`); process.exit(0)
  default: process.exit(97)
}
`

const GH_MOCK = `import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const effects = process.env.EFFECTS_FILE
const args = process.argv.slice(2)
if (effects) appendFileSync(effects, \`gh \${args.join(' ')}\n\`)
if (args[0] === 'release' && args[1] === 'view') {
  const marker = process.env.CREATED_MARKER
  if (marker && existsSync(marker)) {
    const info = { databaseId: 999, isDraft: true, targetCommitish: process.env.TARGET_COMMITISH ?? '', url: 'https://example.invalid' }
    process.stdout.write(\`\${JSON.stringify(info)}\\n\`)
    process.exit(0)
  }
  if (process.env.STALE_DRAFT_JSON) {
    process.stdout.write(\`\${process.env.STALE_DRAFT_JSON}\\n\`)
    process.exit(0)
  }
  process.exit(1)
}
if (args[0] === 'release' && args[1] === 'create') {
  if (process.env.CREATED_MARKER) writeFileSync(process.env.CREATED_MARKER, '')
  process.exit(0)
}
if (args[0] === 'api') process.exit(0)
if (args[0] === 'release' && args[1] === 'upload') process.exit(0)
if (args[0] === 'release' && args[1] === 'download') {
  const dirIndex = args.indexOf('--dir')
  if (dirIndex !== -1) {
    const target = args[dirIndex + 1]
    mkdirSync(target, { recursive: true })
    if (process.env.ASSET_SOURCE) {
      const source = process.env.ASSET_SOURCE
      const manifest = JSON.parse(readFileSync(join(source, 'release-assets.json'), 'utf8'))
      for (const asset of manifest.assets) {
        copyFileSync(join(source, asset.name), join(target, asset.name))
      }
    }
  }
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'edit') process.exit(0)
process.exit(94)
`

function writeMockTool(binDirectory, name, mockSource) {
  writeFileSync(join(binDirectory, `mock-${name}.mjs`), mockSource, 'utf8')
  writeFileSync(
    join(binDirectory, `${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "%~dp0mock-${name}.mjs" %*\r\n`,
    'utf8'
  )
  const posixShim = `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/mock-${name}.mjs" "$@"\n`
  writeFileSync(join(binDirectory, name), posixShim, 'utf8')
  chmodSync(join(binDirectory, name), 0o755)
}

function runPublish(version, commit, assetDirectory, manifestPath, extraEnv) {
  return spawnSync(
    process.execPath,
    [join(toolsDirectory, 'publish-release.mjs'), version, commit, assetDirectory, manifestPath],
    { cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, ...extraEnv } }
  )
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

test('release SBOM command emits CycloneDX 1.7 with all workspace components', () => {
  const version = readManifests().root.version
  const result = spawnSync(process.execPath, ['scripts/generate-sbom.mjs'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)

  const path = join(repositoryRoot, 'artifacts/release', `HubFetch-${version}.cdx.json`)
  assert.equal(existsSync(path), true)
  const sbom = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.7')
  const components = [sbom.metadata.component, ...sbom.components]
  const identities = components.map((component) =>
    [component.group, component.name].filter(Boolean).join('/')
  )
  const workspaceNames = Object.values(readManifests()).map((manifest) => manifest.name)
  assert.deepEqual(
    workspaceNames.sort(),
    identities.filter((value) => workspaceNames.includes(value)).sort()
  )
  assert.ok(sbom.dependencies.length > 0)
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

  const contents = 'verified asset'
  const staged = stageReleaseFixture(assetDirectory, contents)
  const manifestPath = staged.manifestPath

  writeMockTool(binDirectory, 'git', GIT_MOCK)
  writeMockTool(binDirectory, 'gh', GH_MOCK)

  const oldCommit = '0'.repeat(40)
  const commit = 'a'.repeat(40)
  const result = runPublish(staged.version, commit, assetDirectory, manifestPath, {
    HUBFETCH_TOOLCHAIN_DIR: binDirectory,
    PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
    EFFECTS_FILE: effectsFile,
    STALE_DRAFT_JSON: JSON.stringify({
      isDraft: true,
      targetCommitish: oldCommit,
      url: 'https://example.invalid'
    }),
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '123',
    RUNNER_TEMP: runnerTemp
  })

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

  const contents = 'fresh verified asset'
  const staged = stageReleaseFixture(assetDirectory, contents)
  const manifestPath = staged.manifestPath

  writeMockTool(binDirectory, 'git', GIT_MOCK)
  writeMockTool(binDirectory, 'gh', GH_MOCK)

  const commit = 'b'.repeat(40)
  const createdMarker = join(fixture, 'created')
  const result = runPublish(staged.version, commit, assetDirectory, manifestPath, {
    HUBFETCH_TOOLCHAIN_DIR: binDirectory,
    ASSET_SOURCE: assetDirectory,
    CREATED_MARKER: createdMarker,
    GIT_REV_LIST_SHA: commit,
    EFFECTS_FILE: effectsFile,
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '456',
    RUNNER_TEMP: runnerTemp
  })

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

test('publish rejects an unexpected fourth public asset before remote mutation', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-release-extra-'))
  const assetDirectory = join(fixture, 'assets')
  const runnerTemp = join(fixture, 'runner')
  const effectsFile = join(fixture, 'effects.log')
  mkdirSync(assetDirectory, { recursive: true })
  mkdirSync(runnerTemp, { recursive: true })
  const staged = stageReleaseFixture(assetDirectory, 'unexpected asset fixture')
  writeFileSync(join(assetDirectory, 'unexpected.txt'), 'unexpected')

  const result = runPublish(staged.version, 'c'.repeat(40), assetDirectory, staged.manifestPath, {
    EFFECTS_FILE: effectsFile,
    GH_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '789',
    RUNNER_TEMP: runnerTemp
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Remote asset list mismatch/)
  assert.equal(existsSync(effectsFile), false)
})

// ============================================================================
// HubFetch identity contract (plan Todo 12): four current-version manifests, exact
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
  const expectedVersion = manifests.root?.version
  for (const [key, rel] of MANIFEST_PATHS) {
    const manifest = manifests[key]
    if (!manifest) {
      violations.push(`${rel}: manifest missing`)
      continue
    }
    if (manifest.version !== expectedVersion) {
      violations.push(`${rel}: version=${manifest.version}, expected ${expectedVersion}`)
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

test('identity contract: four manifests share the current version and exact HubFetch names', () => {
  const violations = identityViolations(readManifests())
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('identity contract: electron-builder appId/productName/repository are HubFetch', () => {
  const builder = readFileSync(join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
  assert.match(builder, /^appId:\s*io\.github\.oranimp\.hubfetch\s*$/m)
  assert.match(builder, /^productName:\s*HubFetch\s*$/m)
  // The self-update capability and its GitHub release-feed metadata were removed
  // (plan Todo 16): electron-builder must carry no publish/update-feed block.
  assert.doesNotMatch(builder, /^publish:\s*$/m, 'electron-builder publish block must be absent')
  // Todo 17: the builder must satisfy the Windows-x64-zip-only packaging contract.
  assert.deepEqual(builderViolations(builder), [], builderViolations(builder).join('\n'))
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

// ============================================================================
// Todo 17 Windows-x64-ZIP-only packaging contract.
// ============================================================================

const FORBIDDEN_BUILDER_TOP_LEVEL = ['nsis', 'mac', 'linux', 'appImage', 'publish']
const FORBIDDEN_BUILDER_TOKENS = [
  'portable',
  'forceCodeSigning',
  'hardenedRuntime',
  'gatekeeperAssess',
  'entitlements',
  'afterPack',
  'Squirrel',
  'blockmap',
  'latest-mac.yml',
  'latest-linux.yml',
  'app-update.yml',
  'winCodeSign',
  'certificate',
  'signtool',
  'azureSign',
  'signAndEditExecutable',
  'dmg',
  'AppImage',
  '.deb'
]

function stripYamlComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('#')) return ''
      const comment = line.indexOf(' #')
      return comment === -1 ? line : line.slice(0, comment)
    })
    .join('\n')
}

function parseTopLevelKeys(text) {
  const keys = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)[0].length
    if (indent !== 0) continue
    const match = /^([A-Za-z0-9_.-]+):/.exec(line.trim())
    if (match) keys.push(match[1])
  }
  return keys
}

function extractBlock(text, key) {
  const lines = text.split(/\r?\n/)
  const block = []
  let collecting = false
  for (const line of lines) {
    const indent = line.match(/^\s*/)[0].length
    const trimmed = line.trim()
    if (!collecting) {
      if (new RegExp(`^${key}:\\s*$`).test(trimmed)) collecting = true
      continue
    }
    if (trimmed && indent === 0) break
    block.push(line)
  }
  return block.join('\n')
}

function builderViolations(builderText) {
  const text = stripYamlComments(builderText)
  const violations = []
  for (const key of FORBIDDEN_BUILDER_TOP_LEVEL) {
    if (parseTopLevelKeys(text).includes(key)) {
      violations.push(`forbidden top-level key: ${key}`)
    }
  }
  for (const token of FORBIDDEN_BUILDER_TOKENS) {
    if (text.includes(token)) violations.push(`forbidden token: ${token}`)
  }

  const winBlock = extractBlock(text, 'win')
  if (!winBlock.trim()) {
    violations.push('missing win block')
    return violations
  }
  const winEntries = winBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
  const targets = winEntries.filter((line) => /^- target:/.test(line))
  if (targets.length !== 1)
    violations.push(`expected exactly one win target, found ${targets.length}`)
  else if (!/^- target:\s*zip\s*$/.test(targets[0])) violations.push('win target is not zip')
  const arches = winEntries.filter((line) => /^-( x64| ia32| arm64)\s*$/.test(line))
  if (arches.length !== 1 || arches[0] !== '- x64') {
    violations.push(`win arch is not exactly x64: ${arches.join(', ') || '<none>'}`)
  }
  const artifactName = /artifactName:\s*'?([^'\r\n]+)'?/.exec(text)
  if (!artifactName || !artifactName[1].includes('${version}-windows-x64.zip')) {
    violations.push('win artifactName is not HubFetch-${version}-windows-x64.zip')
  }
  return violations
}

test('packaging contract: builder targets exactly one unsigned Windows x64 zip', () => {
  const builder = readFileSync(join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
  const violations = builderViolations(builder)
  assert.deepEqual(violations, [], violations.join('\n'))

  const winBlock = extractBlock(stripYamlComments(builder), 'win')
  const entries = winBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
  assert.deepEqual(
    entries.filter((line) => /^- target:/.test(line)),
    ['- target: zip'],
    'exactly one zip target'
  )
  assert.deepEqual(
    entries.filter((line) => /^-( x64| ia32| arm64)\s*$/.test(line)),
    ['- x64']
  )
})

test('packaging contract negative fixture: portable target and mac block are rejected together', () => {
  const builder = readFileSync(join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
  const broken = builder
    .replace('target: zip', 'target: portable')
    .replace('  artifactName:', 'mac:\n    target:\n      - dmg\n  artifactName:')
  const violations = builderViolations(broken)
  const joined = violations.join('\n')
  assert.match(joined, /portable/, 'portable target must be rejected')
  assert.match(joined, /forbidden top-level key: mac/, 'mac block must be rejected')
  assert.match(joined, /win target is not zip/, 'non-zip target must be rejected')
})

test('packaging contract negative fixtures: each forbidden builder key is rejected', () => {
  const builder = readFileSync(join(repositoryRoot, 'apps/desktop/electron-builder.yml'), 'utf8')
  const injections = {
    nsis: 'nsis:\n  oneClick: false\n',
    linux: 'linux:\n  target:\n    - AppImage\n',
    publish: 'publish:\n  provider: github\n  owner: OranImp\n  repo: HubFetch\n',
    appImage: 'appImage:\n  artifactName: HubFetch-${version}.${ext}\n',
    portable: 'portable:\n  artifactName: HubFetch-${version}-portable.${ext}\n'
  }
  for (const [label, block] of Object.entries(injections)) {
    const broken = `${block}${builder}`
    const violations = builderViolations(broken)
    const joined = violations.join('\n')
    assert.match(
      joined,
      new RegExp(label === 'publish' ? 'forbidden top-level key: publish' : label),
      `${label} must be rejected`
    )
  }
})

const WORKFLOW_FILES = ['verify.yml', 'release.yml', 'packaged-smoke.yml']
const WORKFLOW_FORBIDDEN = [
  'macos-latest',
  'ubuntu-latest',
  'macos-',
  'ubuntu-',
  'xvfb',
  'MAC_CSC',
  'keychain',
  'codesign',
  'AppImage',
  '.deb',
  '.dmg',
  'nsis',
  'portable',
  '--mac',
  '--linux',
  '-c.mac.identity',
  'signed_macos'
]

function workflowViolations(root) {
  const violations = []
  for (const name of WORKFLOW_FILES) {
    const rel = `.github/workflows/${name}`
    const path = join(root, rel)
    if (!existsSync(path)) {
      violations.push(`${rel}: missing`)
      continue
    }
    const body = stripYamlComments(readFileSync(path, 'utf8'))
    if (!/^on:\s*$/m.test(body)) violations.push(`${rel}: missing on: trigger`)
    if (!/^jobs:\s*$/m.test(body)) violations.push(`${rel}: missing jobs: section`)

    const runsOn = [...body.matchAll(/^\s*runs-on:\s*([^\r\n]+)$/gm)]
    if (runsOn.length === 0) violations.push(`${rel}: no runs-on declarations`)
    for (const match of runsOn) {
      const value = match[1].trim()
      if (!value.startsWith('windows')) {
        violations.push(`${rel}: non-Windows runner "${value}"`)
      }
    }
    for (const token of WORKFLOW_FORBIDDEN) {
      if (body.includes(token)) violations.push(`${rel}: forbidden token "${token}"`)
    }
    if (/builder_target|matrix:|platform: (linux|macos)/.test(body)) {
      violations.push(`${rel}: multi-platform matrix present`)
    }
  }
  return violations
}

test('packaging contract: every workflow runner and build target is Windows x64', () => {
  const violations = workflowViolations(repositoryRoot)
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('packaging contract negative fixtures: non-Windows workflow content is rejected', () => {
  for (const [label, mutation] of [
    [
      'ubuntu runner',
      (text) => text.replace(/runs-on:\s*windows-latest/, 'runs-on: ubuntu-latest')
    ],
    ['macos runner', (text) => text.replace(/runs-on:\s*windows-latest/, 'runs-on: macos-latest')],
    ['xvfb', (text) => `${text}\n        xvfb-run pnpm test\n`],
    [
      'mac signing secret',
      (text) => `${text}\n        MAC_CSC_LINK: \${{ secrets.MAC_CSC_LINK }}\n`
    ]
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-workflow-fixture-'))
    const workflowDir = join(fixture, '.github/workflows')
    mkdirSync(workflowDir, { recursive: true })
    for (const name of WORKFLOW_FILES) {
      const source = join(repositoryRoot, '.github/workflows', name)
      writeFileSync(
        join(workflowDir, name),
        name === 'verify.yml'
          ? mutation(readFileSync(source, 'utf8'))
          : readFileSync(source, 'utf8')
      )
    }
    const violations = workflowViolations(fixture)
    assert.ok(violations.length > 0, `${label} must be rejected`)
  }
})

test('packaging contract: package scripts are Windows-only with a package:win command', () => {
  const rootScripts = readManifests().root.scripts ?? {}
  const desktopScripts = readManifests().desktop.scripts ?? {}
  for (const [label, scripts] of [
    ['root', rootScripts],
    ['desktop', desktopScripts]
  ]) {
    for (const key of ['build:linux', 'build:mac', 'build:mac:release']) {
      assert.equal(key in scripts, false, `${label} package.json must not define ${key}`)
    }
  }
  assert.equal(typeof rootScripts['package:win'], 'string')
  assert.equal(typeof desktopScripts['package:win'], 'string')
  assert.ok(rootScripts['package:win'].includes('hubfetch-desktop'))
  assert.ok(desktopScripts['package:win'].includes('--win'))
  assert.ok(desktopScripts['package:win'].includes('--x64'))
  assert.ok(!desktopScripts['package:win'].includes('--mac'))
  assert.ok(!desktopScripts['package:win'].includes('--linux'))
})

test('preflight accepts ZIP plus SBOM and writes SHA-256 plus inventory', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-preflight-ok-'))
  const zipContents = 'fake-zip-bytes'
  const staged = stageReleaseFixture(fixture, zipContents)
  const zipName = staged.zipName

  const manifest = JSON.parse(readFileSync(join(fixture, 'release-assets.json'), 'utf8'))
  assert.equal(manifest.version, staged.version)
  assert.deepEqual(
    manifest.assets.map((entry) => entry.name),
    [zipName, `${zipName}.sha256`, `HubFetch-${staged.version}.cdx.json`]
  )
  const hashFile = readFileSync(join(fixture, `${zipName}.sha256`), 'utf8')
  const expectedHex = createHash('sha256').update(zipContents).digest('hex')
  assert.ok(hashFile.startsWith(`${expectedHex}  ${zipName}`), hashFile)
  assert.equal(manifest.sbom.warningInventory.length, 0)
})

test('SBOM verifier fails closed for malformed spec, missing edge, and local path', () => {
  const source = JSON.parse(readFileSync(generatedSbomPath(), 'utf8'))
  const version = releaseVersion()
  for (const [label, mutate] of [
    [
      'spec',
      (sbom) => {
        sbom.specVersion = '1.6'
      }
    ],
    [
      'dependency',
      (sbom) => {
        const desktopRef = sbom.components.find(
          (component) => component.name === 'hubfetch-desktop'
        )['bom-ref']
        sbom.dependencies.find((entry) => entry.ref === desktopRef).dependsOn.pop()
      }
    ],
    [
      'path',
      (sbom) => {
        sbom.metadata.properties = [{ name: 'fixture', value: 'E:\\private' }]
      }
    ]
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), `hubfetch-sbom-${label}-`))
    const path = join(fixture, 'mutated.cdx.json')
    const mutated = JSON.parse(JSON.stringify(source))
    mutate(mutated)
    writeFileSync(path, `${JSON.stringify(mutated)}\n`)
    const result = spawnSync(
      process.execPath,
      [join(toolsDirectory, 'verify-sbom.mjs'), path, version],
      { encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0, `${label} mutation must fail`)
  }
})

test('SBOM verifier records missing transitive licenses as sorted warnings', () => {
  const source = JSON.parse(readFileSync(generatedSbomPath(), 'utf8'))
  const component = source.components.find((entry) => entry.name === 'chownr')
  assert.ok(component)
  delete component.licenses
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-sbom-warning-'))
  const path = join(fixture, 'warning.cdx.json')
  writeFileSync(path, `${JSON.stringify(source)}\n`)
  const result = spawnSync(
    process.execPath,
    [join(toolsDirectory, 'verify-sbom.mjs'), path, releaseVersion(), '--json'],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(
    output.warningInventory.map((entry) => entry.ref),
    [component['bom-ref']]
  )
})

test('SBOM verifier hard-fails forbidden or missing workspace licenses', () => {
  const source = JSON.parse(readFileSync(generatedSbomPath(), 'utf8'))
  const version = releaseVersion()
  const workspaceComponent = source.metadata.component
  for (const [label, mutate] of [
    [
      'unlicensed',
      (sbom) => {
        sbom.metadata.component.licenses = [{ license: { id: 'UNLICENSED' } }]
      }
    ],
    [
      'see-license',
      (sbom) => {
        sbom.metadata.component.licenses = [{ license: { name: 'SEE LICENSE IN MISSING' } }]
      }
    ],
    [
      'missing-workspace',
      (sbom) => {
        delete sbom.metadata.component.licenses
      }
    ]
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), `hubfetch-sbom-${label}-`))
    const path = join(fixture, 'mutated.cdx.json')
    const mutated = JSON.parse(JSON.stringify(source))
    mutate(mutated)
    writeFileSync(path, `${JSON.stringify(mutated)}\n`)
    const result = spawnSync(
      process.execPath,
      [join(toolsDirectory, 'verify-sbom.mjs'), path, version],
      { encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0, `${label} must fail for ${workspaceComponent.name}`)
  }
})

test('preflight rejects a missing or malformed SBOM before writing outputs', () => {
  const missing = mkdtempSync(join(tmpdir(), 'hubfetch-preflight-no-sbom-'))
  writeFileSync(join(missing, `HubFetch-${releaseVersion()}-windows-x64.zip`), 'bytes')
  const missingResult = spawnSync(
    process.execPath,
    [join(toolsDirectory, 'preflight.mjs'), missing, releaseVersion()],
    { encoding: 'utf8' }
  )
  assert.notEqual(missingResult.status, 0)
  assert.equal(existsSync(join(missing, 'release-assets.json')), false)

  const malformed = mkdtempSync(join(tmpdir(), 'hubfetch-preflight-bad-sbom-'))
  const staged = stageReleaseFixture(malformed, 'bytes')
  const sbomPath = join(malformed, `HubFetch-${staged.version}.cdx.json`)
  const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'))
  sbom.metadata.properties = [{ name: 'fixture', value: 'E:\\private' }]
  writeFileSync(sbomPath, `${JSON.stringify(sbom)}\n`)
  const malformedResult = spawnSync(
    process.execPath,
    [join(toolsDirectory, 'preflight.mjs'), malformed, staged.version],
    { encoding: 'utf8' }
  )
  assert.notEqual(malformedResult.status, 0)
})

test('preflight rejects installers, updater metadata, and other platforms', () => {
  for (const [label, extra] of [
    ['installer', 'HubFetch-1.2.3-setup.exe'],
    ['updater metadata', 'latest.yml'],
    ['mac dmg', 'HubFetch-1.2.3.dmg'],
    ['linux appimage', 'HubFetch-1.2.3.AppImage']
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-preflight-bad-'))
    stageReleaseFixture(fixture, 'bytes')
    writeFileSync(join(fixture, extra), 'bytes')
    const result = spawnSync(
      process.execPath,
      [join(toolsDirectory, 'preflight.mjs'), fixture, releaseVersion()],
      { encoding: 'utf8' }
    )
    assert.notEqual(result.status, 0, `${label} must be rejected`)
    assert.match(result.stderr, /Forbidden|Unexpected/)
  }
})

test('preflight rejects a mismatched version or a non-zip artifact set', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-preflight-ver-'))
  writeFileSync(join(fixture, `HubFetch-${releaseVersion()}-windows-x64.zip`), 'bytes')
  const wrongVersion = spawnSync(
    process.execPath,
    [join(toolsDirectory, 'preflight.mjs'), fixture, '1.2.4'],
    { encoding: 'utf8' }
  )
  assert.notEqual(wrongVersion.status, 0)
  assert.match(wrongVersion.stderr, new RegExp(`is for v${releaseVersion()}`))
})
