#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { verifySbom } from './verify-sbom.mjs'

const directory = resolve(process.argv[2] ?? '')
const expectedVersion = process.argv[3]
const PLAIN_SEMVER = /^\d+\.\d+\.\d+$/

// Todo 17 contract: HubFetch ships exactly one unsigned Windows x64 ZIP plus
// its SHA-256 checksum, CycloneDX SBOM, and release asset inventory. Anything
// that looks like an installer, updater metadata, or another platform's
// artifact is rejected outright.
const WINDOWS_ZIP = /^HubFetch-([0-9]+\.[0-9]+\.[0-9]+)-windows-x64\.zip$/i
const FORBIDDEN_ARTIFACT = /\.(?:exe|msi|dmg|pkg|blockmap|appimage|deb|rpm|zip\.sig|zip\.asc)$/i
const FORBIDDEN_MANIFEST = /^(?:latest\.yml|latest-(?:mac|linux)\.yml|app-update\.yml)$/i

if (!PLAIN_SEMVER.test(expectedVersion ?? '')) {
  throw new Error('Usage: preflight.mjs <asset-directory> <x.y.z>')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function isSafeFileName(name) {
  const segments = name.split(/[\\/]/)
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !isAbsolute(name) &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !segments.some((segment) => segment === '.' || segment === '..') &&
    basename(name) === name &&
    !hasControlCharacters(name)
  )
}

const names = readdirSync(directory).sort((left, right) => left.localeCompare(right))
if (names.length === 0) throw new Error('No release assets were downloaded')

for (const name of names) {
  const path = resolve(directory, name)
  if (!isSafeFileName(name) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error(`Release output must contain only regular files: ${name}`)
  }
  if (statSync(path).size === 0) throw new Error(`Release asset is empty: ${name}`)
}

// Exactly one Windows x64 ZIP for this exact version must be present.
const zips = names.filter((name) => WINDOWS_ZIP.test(name))
if (zips.length !== 1) {
  throw new Error(
    `Expected exactly one HubFetch-${expectedVersion}-windows-x64.zip, found ${zips.length}`
  )
}
const zipName = zips[0]
const versionMatch = WINDOWS_ZIP.exec(zipName)
if (versionMatch[1] !== expectedVersion) {
  throw new Error(`ZIP ${zipName} is for v${versionMatch[1]}, not v${expectedVersion}`)
}

const sbomName = `HubFetch-${expectedVersion}.cdx.json`
const sbomPath = resolve(directory, sbomName)
if (!names.includes(sbomName)) {
  throw new Error(`Expected CycloneDX SBOM ${sbomName}`)
}
const { warningInventory } = verifySbom(sbomPath, expectedVersion)

// Reject installers, updater metadata, and non-Windows artifacts explicitly so
// a regression is caught with a precise message even before the count check.
for (const name of names) {
  if (FORBIDDEN_ARTIFACT.test(name)) {
    throw new Error(`Forbidden release artifact (installer/updater/other platform): ${name}`)
  }
  if (FORBIDDEN_MANIFEST.test(name)) {
    throw new Error(`Forbidden updater metadata: ${name}`)
  }
  if (/\.dmg$|\.app\b|\.deb$|\.AppImage$/i.test(name)) {
    throw new Error(`Non-Windows release artifact: ${name}`)
  }
}

// The ZIP and its SBOM are inputs; checksum and inventories are generated below.
const generated = new Set([`${zipName}.sha256`, 'release-assets.json'])
for (const name of names) {
  if (name !== zipName && name !== sbomName && !generated.has(name)) {
    throw new Error(`Unexpected release output: ${name}`)
  }
}

const zipPath = resolve(directory, zipName)
const hashLine = `${sha256(zipPath)}  ${zipName}\n`
writeFileSync(resolve(directory, `${zipName}.sha256`), hashLine, 'utf8')

const checksumName = `${zipName}.sha256`
const sbomSha256 = sha256(sbomPath)
const assets = [
  {
    name: zipName,
    size: statSync(zipPath).size,
    sha256: sha256(zipPath),
    sha512: sha512(zipPath)
  },
  {
    name: checksumName,
    size: Buffer.byteLength(hashLine),
    sha256: sha256(resolve(directory, checksumName)),
    sha512: sha512(resolve(directory, checksumName))
  },
  {
    name: sbomName,
    size: statSync(sbomPath).size,
    sha256: sbomSha256,
    sha512: sha512(sbomPath)
  }
]
writeFileSync(
  resolve(directory, 'release-assets.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      version: expectedVersion,
      installableAsset: zipName,
      sbom: { name: sbomName, sha256: sbomSha256, warningInventory },
      assets
    },
    null,
    2
  )}\n`,
  'utf8'
)
process.stdout.write(
  `Verified the single unsigned Windows x64 ZIP ${zipName} (${sha256(zipPath).slice(0, 12)}…); ` +
    `wrote checksum, SBOM asset, and inventory for v${expectedVersion} (SBOM warnings=${warningInventory.length}).\n`
)
