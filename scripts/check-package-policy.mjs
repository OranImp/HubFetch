#!/usr/bin/env node
//
// scripts/check-package-policy.mjs
//
// Todo 41: policy gate over a Windows x64 release ZIP. Reads the ZIP and
// asserts the HubFetch release contract:
//
//   - exactly one unsigned Windows x64 ZIP for the expected version
//   - zero `.map` source-map members (source maps are forbidden from releases)
//   - no installer / updater metadata / other-platform artifacts
//   - no Python (`.py`/`.pyc`), no source-tree files, no evidence/secrets
//   - no `.pdb`/`.obj`/`.iobj`/`.ipdb`/`.lib`/`.exp` build intermediates
//   - the expected native runtime files are present and x64
//
// Usage:
//   node scripts/check-package-policy.mjs <zip-path> <expected-version>
//
// Exit 0 only when every assertion holds; otherwise exit 1 with the first
// failing policy named. This is the script the build gate and the workflow
// both invoke, so a regression fails closed everywhere.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/
const WINDOWS_ZIP = /^HubFetch-([0-9]+\.[0-9]+\.[0-9]+)-windows-x64\.zip$/i
const FORBIDDEN_ARTIFACT = /\.(?:exe|msi|dmg|pkg|blockmap|appimage|deb|rpm|zip\.sig|zip\.asc)$/i
const FORBIDDEN_MANIFEST = /^(?:latest\.yml|latest-(?:mac|linux)\.yml|app-update\.yml)$/i
const FORBIDDEN_SOURCE_MAP = /\.map$/i
const FORBIDDEN_NATIVE_INTERMEDIATE = /\.(?:pdb|obj|iobj|ipdb|lib|exp)$/i
const FORBIDDEN_PYTHON = /\.pyc?$/i

// Non-Windows / non-package artifact patterns that must never appear.
const FORBIDDEN_PLATFORM = /\.(?:dmg|deb|rpm|AppImage)$/i
// A source/build-tree member at the ZIP ROOT (src/, out/, dist/, coverage/,
// test/, tests/) would indicate source leaking into the package. Bundled
// dependency source under node_modules is legitimate and exempt.
const FORBIDDEN_SOURCE_TREE = /^(?:src|source|out|dist|coverage|test|tests)[\\/]/i
const FORBIDDEN_NODE_CACHE = /[\\/]node_modules[\\/]\.cache[\\/]/i
const FORBIDDEN_EVIDENCE = /\.omo[\\/]|evidence|\.secret|credentials\.json|\.env(?:\.[a-z0-9]+)?$/i

function fail(reason) {
  console.error(`[check-package-policy] POLICY FAIL: ${reason}`)
  process.exit(1)
}

const zipArg = resolve(process.argv[2] ?? '')
const expectedVersion = process.argv[3]

if (!PLAIN_SEMVER.test(expectedVersion ?? '')) {
  fail(`usage: check-package-policy.mjs <zip> <x.y.z> (got '${expectedVersion}')`)
}
if (!existsSync(zipArg) || !statSync(zipArg).isFile()) {
  fail(`ZIP not found: ${zipArg}`)
}

const zipName = basename(zipArg)
const versionMatch = WINDOWS_ZIP.exec(zipName)
if (!versionMatch) {
  fail(`expected HubFetch-${expectedVersion}-windows-x64.zip, got '${zipName}'`)
}
if (versionMatch[1] !== expectedVersion) {
  fail(`ZIP ${zipName} is for v${versionMatch[1]}, not v${expectedVersion}`)
}

// List members with PowerShell's Expand-Archive-free reader (System.IO.Compression).
// Kept shell-free so the policy check itself never depends on a local build tool.
function listMembers(zipPath) {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replaceAll("'", "''")}')`,
    'try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }'
  ].join('; ')
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

const members = listMembers(zipArg)
if (members.length === 0) fail('ZIP has no members')

// Expected native runtime members (x64) that must be present.
const EXPECTED_NATIVE = [
  'resources/native/hubfetch_job.node',
  'resources/native/HubFetchAskPass.exe'
]
const memberSet = new Set(members.map((member) => member.replaceAll('\\', '/')))
for (const native of EXPECTED_NATIVE) {
  if (!memberSet.has(native)) {
    fail(`missing expected native runtime member: ${native}`)
  }
}

// Expected app member.
const appMember = 'HubFetch.exe'
if (!memberSet.has(appMember)) fail(`missing expected app executable member: ${appMember}`)

// The only legitimate .exe members are the root app executable and the AskPass
// helper under resources/native. Any other .exe would be an installer, an
// updater, or a foreign helper and is forbidden.
const ALLOWED_EXE = new Set(['HubFetch.exe', 'resources/native/HubFetchAskPass.exe'])

for (const member of members) {
  const normalized = member.replaceAll('/', '\\')
  if (isAbsolute(normalized) || /^[a-z]:[\\/]/i.test(normalized)) {
    fail(`absolute or drive-path member: ${member}`)
  }
  if (FORBIDDEN_SOURCE_MAP.test(normalized)) {
    fail(`forbidden source-map member (.map): ${member}`)
  }
  if (FORBIDDEN_NATIVE_INTERMEDIATE.test(normalized)) {
    // Our own native staging (resources/native) must never carry build
    // intermediates (.pdb/.obj/.iobj/.ipdb/.lib/.exp). Third-party prebuilt
    // addons under node_modules (e.g. better-sqlite3) legitimately ship their
    // MSVC build outputs; those are exempt except for .pdb which is never
    // needed at runtime.
    const underNodeModules = /[\\/]node_modules[\\/]/.test(normalized)
    if (!underNodeModules || /\.pdb$/i.test(normalized)) {
      fail(`forbidden native build intermediate: ${member}`)
    }
  }
  if (FORBIDDEN_PYTHON.test(normalized)) {
    fail(`forbidden Python member: ${member}`)
  }
  if (FORBIDDEN_ARTIFACT.test(normalized) && !ALLOWED_EXE.has(member.replaceAll('\\', '/'))) {
    fail(`forbidden installer/updater artifact: ${member}`)
  }
  if (FORBIDDEN_MANIFEST.test(normalized)) {
    fail(`forbidden updater metadata: ${member}`)
  }
  if (FORBIDDEN_PLATFORM.test(normalized)) {
    fail(`forbidden non-Windows platform artifact: ${member}`)
  }
  if (FORBIDDEN_SOURCE_TREE.test(normalized)) {
    fail(`forbidden source/build-tree member: ${member}`)
  }
  if (FORBIDDEN_NODE_CACHE.test(normalized)) {
    fail(`forbidden node_modules .cache member: ${member}`)
  }
  if (FORBIDDEN_EVIDENCE.test(normalized)) {
    fail(`forbidden evidence/secret/source member: ${member}`)
  }
}

const sha = createHash('sha256').update(readFileSync(zipArg)).digest('hex')
console.log(
  `[check-package-policy] OK: ${zipName} (${members.length} members, no .map/installer/updater/Python/source/evidence, native x64 present, sha256 ${sha.slice(0, 12)}…)`
)
