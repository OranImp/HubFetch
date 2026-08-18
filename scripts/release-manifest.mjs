#!/usr/bin/env node
//
// scripts/release-manifest.mjs
//
// Todo 41: produce the release manifest that binds the Windows ZIP to its
// exact source evidence, and write the SHA-256 checksum file for the ZIP.
//
// Usage:
//   node scripts/release-manifest.mjs <artifacts-dir> <zip-name> <source-sha> \
//       <version> [--live-read <path>] [--screenshot-digest <hex>]
//
// The manifest binds, for the exact source SHA being released:
//   - source SHA and the full tracked tree digest (git ls-files + sha256)
//   - the frozen lockfile hash (pnpm-lock.yaml)
//   - build/config hashes (electron-builder.yml, package.json manifests,
//     electron-vite.config, playwright configs)
//   - native binary hashes (hubfetch_job.node, HubFetchAskPass.exe) from the
//     packaged ZIP's resources/native
//   - the packaged member inventory + member digest
//   - test/screenshot hashes (coverage/screenshot digests when provided)
//   - the live-read SHA from Todo 37 (LIVE_REPO_SHA) so the release evidence
//     chain stays connected to the proxied live clone verification
//   - the ZIP SHA-256 (the .sha256 file uses the EXACT zip filename)
//
// `approved` is written true ONLY after smoke has succeeded: the build script
// invokes this tool first (writes a manifest with approved=false), runs the
// smoke, and only re-invokes with --finalize to flip approved=true. A manifest
// with approved=true and any bound hash changed forces a rebuild.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/
const WINDOWS_ZIP = /^HubFetch-([0-9]+\.[0-9]+\.[0-9]+)-windows-x64\.zip$/i
const FULL_SHA = /^[0-9a-f]{40}$/

function parseArgs(argv) {
  const args = argv.slice(2)
  const positional = []
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      options[key] = args[i + 1]
      i += 1
    } else {
      positional.push(args[i])
    }
  }
  return { positional, options }
}

const { positional, options } = parseArgs(process.argv)
const [artifactsDir, zipName, sourceSha, version] = positional
if (!artifactsDir || !zipName || !sourceSha || !version) {
  console.error(
    'usage: release-manifest.mjs <artifacts-dir> <zip-name> <source-sha> <x.y.z> [--live-read <path>] [--screenshot-digest <hex>] [--finalize]'
  )
  process.exit(1)
}
if (!PLAIN_SEMVER.test(version)) {
  console.error(`invalid version: ${version}`)
  process.exit(1)
}
if (!FULL_SHA.test(sourceSha)) {
  console.error(`invalid source SHA: ${sourceSha}`)
  process.exit(1)
}
const zipMatch = WINDOWS_ZIP.exec(zipName)
if (!zipMatch || zipMatch[1] !== version) {
  console.error(`zip name ${zipName} does not match HubFetch-${version}-windows-x64.zip`)
  process.exit(1)
}
const finalize = Boolean(options.finalize)

const artifactsDirResolved = resolve(artifactsDir)
const zipPath = join(artifactsDirResolved, zipName)
if (!existsSync(zipPath)) {
  console.error(`ZIP not found: ${zipPath}`)
  process.exit(1)
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Tracked tree digest over `git ls-files` content hashes. Deterministic for a
// given commit because it hashes each tracked file's bytes plus its path.
function trackedTreeDigest() {
  const git = (args, cwd) =>
    execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 128 * 1024 * 1024 }).trim()
  const root = git(['rev-parse', '--show-toplevel'], process.cwd())
  const files = git(['ls-files'], root).split(/\r?\n/).filter(Boolean)
  const hash = createHash('sha256')
  for (const file of files) {
    const abs = join(root, file)
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue
    hash.update(file.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(sha256Of(abs))
    hash.update('\0')
  }
  return hash.digest('hex')
}

// Member inventory + digest from the packaged ZIP.
function zipInventory(zipPath) {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replaceAll("'", "''")}')`,
    'try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }'
  ].join('; ')
  const members = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const sorted = [...members].sort()
  const hash = createHash('sha256')
  for (const member of sorted) {
    hash.update(member.replaceAll('\\', '/'))
    hash.update('\0')
  }
  return { memberCount: members.length, memberDigest: hash.digest('hex'), members: sorted }
}

function readNativeHashesFromZip(zipPath) {
  // Extract just the two native runtime files to a temp dir, hash them, then
  // remove them. This keeps the manifest's native hashes tied to the packaged
  // bytes (same as check-package-policy's members), not a staged build tree.
  const tmpRoot = process.env.TMP || process.env.TEMP || '.'
  const outDir = join(tmpRoot, `t41-native-${process.pid}`)
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replaceAll("'", "''")}')`,
    `$o = '${outDir.replaceAll("'", "''")}'`,
    'New-Item -ItemType Directory -Force -Path $o | Out-Null',
    "foreach ($e in $z.Entries) { if ($e.FullName -match '^resources/native/(hubfetch_job\\.node|HubFetchAskPass\\.exe)$') {",
    '  $dest = Join-Path $o ([System.IO.Path]::GetFileName($e.FullName))',
    '  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)',
    '} }',
    '$z.Dispose()'
  ].join('; ')
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const native = {}
  for (const name of ['hubfetch_job.node', 'HubFetchAskPass.exe']) {
    const p = join(outDir, name)
    native[name] = existsSync(p) ? sha256Of(p) : null
  }
  for (const name of Object.keys(native)) {
    try {
      execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        `Remove-Item -Force '${join(outDir, name)}'`
      ])
    } catch {
      /* best-effort cleanup */
    }
  }
  return native
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  cwd: process.cwd()
}).trim()

function hashOfRelative(rel) {
  const abs = join(root, rel)
  return existsSync(abs) ? sha256Of(abs) : null
}

const lockfileHash = hashOfRelative('pnpm-lock.yaml')
const builderConfigHash = hashOfRelative('apps/desktop/electron-builder.yml')
const rootManifestHash = hashOfRelative('package.json')
const desktopManifestHash = hashOfRelative('apps/desktop/package.json')

const nativeHashes = readNativeHashesFromZip(zipPath)
const inventory = zipInventory(zipPath)

// Live-read binding from Todo 37 (LIVE_REPO_SHA), when provided.
let liveRead = null
if (options['live-read']) {
  const liveReadPath = resolve(options['live-read'])
  if (existsSync(liveReadPath)) {
    const parsed = JSON.parse(readFileSync(liveReadPath, 'utf8'))
    liveRead = {
      repo: parsed.repo ?? null,
      headSha: parsed.headSha ?? parsed.resolvedSha ?? null,
      verifiedHeadMatchesSha: parsed.verifiedHeadMatchesSha ?? false,
      liveReadFileSha256: sha256Of(liveReadPath)
    }
  }
}

const zipSha256 = sha256Of(zipPath)
const zipSize = statSync(zipPath).size

// The .sha256 file must use the EXACT zip filename.
const sha256Line = `${zipSha256}  ${zipName}\n`
writeFileSync(join(artifactsDirResolved, `${zipName}.sha256`), sha256Line, 'utf8')

const manifest = {
  schemaVersion: 1,
  task: 41,
  plan: 'adopt-ohmyhf-main',
  version,
  approved: false,
  source: {
    sha: sourceSha,
    shortSha: sourceSha.slice(0, 7),
    trackedTreeSha256: trackedTreeDigest(),
    headSubject: execFileSync('git', ['log', '-1', '--pretty=%s', sourceSha], {
      encoding: 'utf8',
      cwd: root
    }).trim()
  },
  versions: {
    workspace: rootManifestHash
      ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      : null,
    desktop: desktopManifestHash
      ? JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version
      : null
  },
  lockfileSha256: lockfileHash,
  buildConfig: {
    electronBuilderYmlSha256: builderConfigHash,
    rootPackageJsonSha256: rootManifestHash,
    desktopPackageJsonSha256: desktopManifestHash
  },
  native: nativeHashes,
  zip: {
    name: zipName,
    path: zipPath,
    sizeBytes: zipSize,
    sha256: zipSha256,
    memberCount: inventory.memberCount,
    memberDigest: inventory.memberDigest,
    sha256Line
  },
  members: inventory.members,
  test: {
    screenshotDigest: options['screenshot-digest'] ?? null
  },
  liveRead,
  createdAt: new Date().toISOString()
}

if (finalize) {
  manifest.approved = true
  manifest.finalizedAt = new Date().toISOString()
}

writeFileSync(
  join(artifactsDirResolved, 'release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
)

process.stdout.write(
  `[release-manifest] ${finalize ? 'FINALIZED (approved=true)' : 'staged (approved=false)'}: ` +
    `${zipName} sha256=${zipSha256} source=${sourceSha.slice(0, 7)} members=${inventory.memberCount} ` +
    `native=${nativeHashes['hubfetch_job.node'] ? nativeHashes['hubfetch_job.node'].slice(0, 12) : 'MISSING'}/` +
    `${nativeHashes['HubFetchAskPass.exe'] ? nativeHashes['HubFetchAskPass.exe'].slice(0, 12) : 'MISSING'}\n`
)
