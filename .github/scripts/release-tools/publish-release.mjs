#!/usr/bin/env node

// Windows-compatible replacement for the old publish-release.sh. Creates or
// resumes the release draft, replaces its asset set, downloads the remote
// assets back and verifies them against the preflight manifest, then publishes
// only after the tag points at the exact verified commit. Spawns git/gh via
// child_process (no bash); HUBFETCH_TOOLCHAIN_DIR optionally overrides git/gh
// with .cmd/.bat/.exe mocks so the release-tool tests run on Windows too.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = process.argv[2] ?? ''
const COMMIT_SHA = process.argv[3] ?? ''
const ASSET_DIR = resolve(process.argv[4] ?? '')
const ASSET_MANIFEST = resolve(process.argv[5] ?? '')
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/
const FULL_SHA = /^[0-9a-f]{40}$/

function die(message) {
  console.error(message)
  process.exit(1)
}

if (!PLAIN_SEMVER.test(VERSION)) die(`Invalid release version: ${VERSION}`)
if (!FULL_SHA.test(COMMIT_SHA)) die(`Invalid release commit: ${COMMIT_SHA}`)
for (const envKey of ['GH_TOKEN', 'GITHUB_REPOSITORY', 'RUNNER_TEMP']) {
  if (!process.env[envKey]) die(`${envKey} is required`)
}

const TAG = `v${VERSION}`
const TOOLCHAIN_DIR = process.env.HUBFETCH_TOOLCHAIN_DIR ?? ''
const TOOLS_DIRECTORY = dirname(fileURLToPath(import.meta.url))

function runTool(program, args, options = {}) {
  let candidate = program
  let useShell = false
  if (TOOLCHAIN_DIR) {
    for (const [name, shell] of [
      [`${program}.cmd`, true],
      [`${program}.bat`, true],
      [`${program}.exe`, false],
      [program, false]
    ]) {
      const path = join(TOOLCHAIN_DIR, name)
      if (existsSync(path)) {
        candidate = path
        useShell = shell
        break
      }
    }
  }
  return spawnSync(candidate, args, { encoding: 'utf8', shell: useShell, ...options })
}

function tool(name, args, options = {}) {
  const result = runTool(name, args, options)
  if (result.error) die(`Failed to spawn ${name}: ${result.error.message}`)
  return result
}

function verifyAssets(manifestPath, assetDirectory) {
  const result = runTool(process.execPath, [
    join(TOOLS_DIRECTORY, 'verify-assets.mjs'),
    manifestPath,
    assetDirectory
  ])
  if (result.error) die(`Failed to spawn verify-assets: ${result.error.message}`)
  if (result.status !== 0)
    die((result.stderr ?? '').trim() || `verify-assets failed (status ${result.status})`)
}

// Validate the local asset set before any remote state is touched.
verifyAssets(ASSET_MANIFEST, ASSET_DIR)

const manifest = JSON.parse(readFileSync(ASSET_MANIFEST, 'utf8'))
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  die('Release asset manifest contains no assets')
}
const uploadPaths = manifest.assets.map((asset) => join(ASSET_DIR, asset.name))

// Parse and validate the tag state before creating any remote resources.
const lsRemote = tool('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${TAG}`])
const tagLookupStatus = lsRemote.status
if (tagLookupStatus === 0) {
  tool('git', ['fetch', '--force', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`])
  const existingSha = tool('git', ['rev-list', '-n', '1', TAG]).stdout.trim()
  if (existingSha !== COMMIT_SHA)
    die(`Tag ${TAG} already points to ${existingSha}, not ${COMMIT_SHA}`)
} else if (tagLookupStatus !== 2) {
  die(`Unable to verify whether tag ${TAG} already exists (git ls-remote exit ${tagLookupStatus})`)
}

const remoteDirectory = join(
  process.env.RUNNER_TEMP,
  `ohmyhf-release-remote-${process.env.GITHUB_RUN_ID}`
)
mkdirSync(remoteDirectory, { recursive: true })

let releaseId
const view = tool('gh', [
  'release',
  'view',
  TAG,
  '--json',
  'isDraft,targetCommitish,url,databaseId'
])
if (view.status === 0) {
  const info = JSON.parse(view.stdout)
  if (info.targetCommitish !== COMMIT_SHA) {
    die(`Release ${TAG} targets ${info.targetCommitish}, not ${COMMIT_SHA}`)
  }
  if (info.isDraft !== true) {
    tool('gh', ['release', 'download', TAG, '--dir', remoteDirectory, '--pattern', '*'])
    verifyAssets(ASSET_MANIFEST, remoteDirectory)
    console.log(`Release ${TAG} is already published with the verified asset set.`)
    process.exit(0)
  }
  releaseId = info.databaseId
} else {
  const describe = tool('git', [
    'describe',
    '--tags',
    '--abbrev=0',
    '--match',
    'v*',
    `${COMMIT_SHA}^`
  ])
  const previousTag = describe.status === 0 ? describe.stdout.trim() : ''
  const notes = ['## What changed', '']
  const range = previousTag ? `${previousTag}..${COMMIT_SHA}` : COMMIT_SHA
  const log = tool('git', ['log', '--no-merges', '--pretty=- %s (%h)', range])
  const entries = (log.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('- [RELEASE]'))
  if (entries.length > 0) notes.push(...entries)
  else notes.push('- Maintenance release.')
  if (previousTag) {
    notes.push(
      '',
      `**Full changelog**: https://github.com/${process.env.GITHUB_REPOSITORY}/compare/${previousTag}...${TAG}`
    )
  }
  const notesFile = join(process.env.RUNNER_TEMP, 'ohmyhf-release-notes.md')
  writeFileSync(notesFile, `${notes.join('\n')}\n`, 'utf8')

  tool('gh', [
    'release',
    'create',
    TAG,
    '--target',
    COMMIT_SHA,
    '--draft',
    '--title',
    TAG,
    '--notes-file',
    notesFile
  ])
  // A fresh draft's tag is not a resolvable git ref yet (that only happens at
  // publish time below), so it must be looked up by name here — the
  // tag-scoped REST endpoint used for asset listing further down 404s until
  // the ref exists, but `gh release view` resolves drafts by release name.
  releaseId = JSON.parse(
    tool('gh', ['release', 'view', TAG, '--json', 'databaseId']).stdout
  ).databaseId
}

// A failed prior run may have left a draft with stale or partial assets. Replace
// the entire draft asset set so reruns converge on the preflight manifest.
// Addressed by numeric release id, not by tag name: a draft's tag is not a
// resolvable git ref yet, and repos/.../releases/tags/{tag} 404s until it is.
const existingIds = tool('gh', [
  'api',
  `repos/${process.env.GITHUB_REPOSITORY}/releases/${releaseId}/assets`,
  '--jq',
  '.[].id'
]).stdout
for (const line of existingIds.split(/\r?\n/)) {
  const assetId = line.trim()
  if (!assetId) continue
  if (!/^\d+$/.test(assetId)) die(`GitHub returned an invalid release asset id: ${assetId}`)
  tool('gh', [
    'api',
    '--method',
    'DELETE',
    `repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${assetId}`
  ])
}

tool('gh', ['release', 'upload', TAG, ...uploadPaths])
tool('gh', ['release', 'download', TAG, '--dir', remoteDirectory, '--pattern', '*'])
verifyAssets(ASSET_MANIFEST, remoteDirectory)

if (tagLookupStatus === 2) {
  // Draft releases do not guarantee that the Git ref already exists. Create it
  // only after every local and remote asset check has passed. A concurrent tag
  // creation makes the push fail; the fetch-and-compare below then decides safely.
  const push = tool('git', ['push', 'origin', `${COMMIT_SHA}:refs/tags/${TAG}`])
  if (push.status !== 0)
    console.log('Tag creation raced or failed; verifying the remote ref before publish.')
}
tool('git', ['fetch', '--force', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`])
const publishedSha = tool('git', ['rev-list', '-n', '1', TAG]).stdout.trim()
if (publishedSha !== COMMIT_SHA) die(`Refusing to publish: tag ${TAG} moved to ${publishedSha}`)
tool('gh', ['release', 'edit', TAG, '--draft=false', '--latest'])
console.log(`Published ${TAG} after remote asset verification.`)
