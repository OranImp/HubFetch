#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { verifySbom } from './verify-sbom.mjs'

const manifestPath = resolve(process.argv[2] ?? '')
const directory = resolve(process.argv[3] ?? '')

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: verify-assets.mjs <release-assets.json> <asset-directory>')
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (
  manifest.schemaVersion !== 1 ||
  !/^\d+\.\d+\.\d+$/.test(manifest.version ?? '') ||
  !Array.isArray(manifest.assets)
) {
  throw new Error('Unsupported release asset manifest')
}

const expectedZipName = `HubFetch-${manifest.version}-windows-x64.zip`
const expectedSbomName = `HubFetch-${manifest.version}.cdx.json`
const allowedNames = new Set([expectedZipName, `${expectedZipName}.sha256`, expectedSbomName])

const expected = new Map()
const hasControlCharacters = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })

for (const asset of manifest.assets) {
  const segments = typeof asset?.name === 'string' ? asset.name.split(/[\\/]/) : []
  if (
    !asset ||
    typeof asset.name !== 'string' ||
    isAbsolute(asset.name) ||
    asset.name.includes('/') ||
    asset.name.includes('\\') ||
    segments.some((segment) => segment === '.' || segment === '..') ||
    basename(asset.name) !== asset.name ||
    hasControlCharacters(asset.name) ||
    asset.name === '.' ||
    asset.name === '..' ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    !/^[0-9a-f]{64}$/i.test(asset.sha256 ?? '') ||
    typeof asset.sha512 !== 'string' ||
    !allowedNames.has(asset.name) ||
    expected.has(asset.name)
  ) {
    throw new Error('Release asset manifest contains an invalid entry')
  }
  expected.set(asset.name, asset)
}

if (
  expected.size !== allowedNames.size ||
  [...expected.keys()].some((name) => !allowedNames.has(name))
) {
  throw new Error('Release asset manifest must contain exactly ZIP, checksum, and CycloneDX SBOM')
}
if (
  manifest.installableAsset !== expectedZipName ||
  manifest.sbom?.name !== expectedSbomName ||
  !/^[0-9a-f]{64}$/i.test(manifest.sbom?.sha256 ?? '') ||
  !Array.isArray(manifest.sbom?.warningInventory)
) {
  throw new Error('Release asset manifest has invalid SBOM metadata')
}

const actualNames = readdirSync(directory)
  .filter((name) => resolve(directory, name) !== manifestPath && name !== 'release-manifest.json')
  .sort((left, right) => left.localeCompare(right))
const expectedNames = [...expected.keys()].sort((left, right) => left.localeCompare(right))

if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  throw new Error(
    `Remote asset list mismatch: expected [${expectedNames.join(', ')}], got [${actualNames.join(', ')}]`
  )
}

for (const name of actualNames) {
  const path = resolve(directory, name)
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`Asset is not a regular file: ${name}`)

  const asset = expected.get(name)
  const hash = createHash('sha512').update(readFileSync(path)).digest('base64')
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (info.size !== asset.size || hash !== asset.sha512 || sha256 !== asset.sha256) {
    throw new Error(`Asset does not match preflight output: ${name}`)
  }
}

const sbomPath = resolve(directory, expectedSbomName)
const verification = verifySbom(sbomPath, manifest.version)
if (
  sha256Of(sbomPath) !== manifest.sbom.sha256 ||
  JSON.stringify(verification.warningInventory) !== JSON.stringify(manifest.sbom.warningInventory)
) {
  throw new Error('Release SBOM metadata does not match the verified SBOM')
}

process.stdout.write(`Verified ${actualNames.length} assets against the preflight manifest.\n`)

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
