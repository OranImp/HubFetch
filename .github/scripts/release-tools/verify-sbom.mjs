#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const workspaceEntries = [
  ['root', 'package.json'],
  ['desktop', 'apps/desktop/package.json'],
  ['shared', 'packages/shared/package.json'],
  ['hub-api', 'packages/hub-api/package.json']
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function identity(component) {
  return [component.group, component.name].filter(Boolean).join('/')
}

function licenseValues(value) {
  const values = []
  const collect = (entry) => {
    if (typeof entry === 'string') values.push(entry)
    else if (entry && typeof entry === 'object') {
      for (const key of ['id', 'name', 'expression', 'type']) {
        if (typeof entry[key] === 'string') values.push(entry[key])
      }
      if (entry.license) collect(entry.license)
    }
  }
  if (Array.isArray(value)) value.forEach(collect)
  else collect(value)
  return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))]
}

function packageLicenseValues(manifest) {
  return licenseValues(manifest.license ?? manifest.licenses)
}

function forbiddenLicense(values, label, packageDirectory) {
  for (const value of values) {
    if (/^UNLICENSED$/i.test(value)) throw new Error(`${label} declares UNLICENSED`)
    const see = /^SEE LICENSE IN\s+(.+)$/i.exec(value)
    if (see && !existsSync(join(packageDirectory, see[1].trim()))) {
      throw new Error(`${label} references a missing license file: ${see[1].trim()}`)
    }
  }
}

function installedPackage(root, packageName) {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(packageName)) return null
  const packagePath = join(root, 'node_modules', ...packageName.split('/'), 'package.json')
  if (!existsSync(packagePath)) return null
  const manifest = readJson(packagePath)
  return typeof manifest.version === 'string' ? { manifest, directory: dirname(packagePath) } : null
}

function scanForLeaks(raw, root) {
  const normalizedRoot = root.replaceAll('\\', '/')
  const patterns = [
    /(?:^|["\s])(?:[A-Za-z]:[\\/]|\\\\)/,
    /\\\\[^\\/]+[\\/]/,
    /(?:^|["\s])\/(?:Users|home|private|workspace|tmp|var|etc|mnt|opt|root)(?:\/|["\s])/i,
    /(?:process\.env|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|npm_config_(?:proxy|https_proxy)|GH_TOKEN|GITHUB_TOKEN|RUNNER_TEMP|HUBFETCH_[A-Z_]+)/i,
    /(?:https?|git\+https?):\/\/[^/\s"'@:]+:[^/\s"'@]+@/i,
    /"[^"\r\n]*(?:token|cookie|password|authorization|secret|credential|environment|env|api[_-]?key|proxy(?:[_-]?(?:user|pass|password|credential)))[^"\r\n]*"\s*:/i,
    /\b(?:hf|ghp|github_pat|sk)-[A-Za-z0-9_-]{10,}\b/,
    /\b(?:secret|token|cookie)[_-]?(?:sentinel|fixture|value)\b/i,
    /127\.0\.0\.1:7897/
  ]
  if (raw.includes(normalizedRoot) || raw.includes(root)) {
    throw new Error('SBOM contains a workspace absolute path')
  }
  const match = patterns.find((pattern) => pattern.test(raw))
  if (match) throw new Error(`SBOM contains forbidden local or secret material (${match})`)
}

function workspaceManifests(root) {
  return workspaceEntries.map(([key, relativePath]) => ({
    key,
    path: relativePath,
    directory: dirname(join(root, relativePath)),
    manifest: readJson(join(root, relativePath))
  }))
}

function expectedDependencyRefs(packages, componentsByIdentity) {
  const workspaceByName = new Map(packages.map((entry) => [entry.manifest.name, entry]))
  const componentsByName = new Map(
    [...componentsByIdentity.values()].map((component) => [identity(component), component])
  )
  const sets = new Map()
  for (const entry of packages) {
    const refs = new Set()
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, specifier] of Object.entries(entry.manifest[field] ?? {})) {
        if (field === 'devDependencies' && !specifier.startsWith('workspace:')) continue
        const targetPackage = workspaceByName.get(name)
        const targetVersion = targetPackage?.manifest.version
        const target = targetPackage
          ? componentsByIdentity.get(`${name}@${targetVersion}`)
          : componentsByName.get(name)
        if (!target) {
          if (targetPackage || field !== 'devDependencies') {
            throw new Error(`${entry.path} dependency is absent from the SBOM: ${name}`)
          }
          continue
        }
        refs.add(target['bom-ref'])
      }
    }
    sets.set(entry.manifest.name, refs)
  }
  return sets
}

export function verifySbom(sbomPath, expectedVersion, root = repositoryRoot) {
  const raw = readFileSync(sbomPath, 'utf8')
  scanForLeaks(raw, root)
  const sbom = JSON.parse(raw)
  if (sbom.bomFormat !== 'CycloneDX') throw new Error('SBOM bomFormat must be CycloneDX')
  if (sbom.specVersion !== '1.7') throw new Error('SBOM specVersion must be 1.7')
  if (!sbom.metadata?.component || !Array.isArray(sbom.components)) {
    throw new Error('SBOM metadata.component and components are required')
  }

  const packages = workspaceManifests(root)
  const allComponents = [sbom.metadata.component, ...sbom.components]
  const rootManifest = packages[0].manifest
  if (
    identity(sbom.metadata.component) !== rootManifest.name ||
    sbom.metadata.component.version !== rootManifest.version
  ) {
    throw new Error('SBOM metadata.component must be the root workspace package')
  }
  const byRef = new Map()
  const byIdentity = new Map()
  for (const component of allComponents) {
    const ref = component['bom-ref']
    if (typeof ref !== 'string' || byRef.has(ref))
      throw new Error('SBOM component references must be unique')
    byRef.set(ref, component)
    byIdentity.set(`${identity(component)}@${component.version}`, component)
  }

  const workspaceRefs = new Map()
  for (const entry of packages) {
    const manifest = entry.manifest
    if (manifest.version !== expectedVersion) {
      throw new Error(`${entry.path} version does not match ${expectedVersion}`)
    }
    const component = byIdentity.get(`${manifest.name}@${manifest.version}`)
    if (!component) throw new Error(`SBOM is missing workspace component ${manifest.name}`)
    if (workspaceRefs.has(component['bom-ref']))
      throw new Error('SBOM contains duplicate workspace components')
    workspaceRefs.set(component['bom-ref'], entry)
    const manifestLicenses = packageLicenseValues(manifest)
    forbiddenLicense(manifestLicenses, `${entry.path} package metadata`, entry.directory)
    const sbomLicenses = licenseValues(component.licenses)
    forbiddenLicense(sbomLicenses, `${manifest.name} SBOM component`, entry.directory)
    if (manifestLicenses.length === 0 || sbomLicenses.length === 0) {
      throw new Error(`Workspace component ${manifest.name} is missing a license`)
    }
    if (!manifestLicenses.some((license) => sbomLicenses.includes(license))) {
      throw new Error(
        `Workspace component ${manifest.name} license does not match package metadata`
      )
    }
  }
  if (workspaceRefs.size !== 4)
    throw new Error('SBOM must contain exactly four workspace components')

  const warningInventory = []
  for (const component of allComponents) {
    const sbomLicenses = licenseValues(component.licenses)
    const packageInfo = installedPackage(root, identity(component))
    const matchingPackageInfo =
      packageInfo?.manifest.version === component.version ? packageInfo : null
    const workspaceDirectory = workspaceRefs.get(component['bom-ref'])?.directory
    forbiddenLicense(
      sbomLicenses,
      `${identity(component)} SBOM component`,
      workspaceDirectory ?? matchingPackageInfo?.directory ?? root
    )
    if (matchingPackageInfo) {
      const metadataLicenses = packageLicenseValues(matchingPackageInfo.manifest)
      forbiddenLicense(
        metadataLicenses,
        `${identity(component)} package metadata`,
        matchingPackageInfo.directory
      )
      if (
        metadataLicenses.length > 0 &&
        !metadataLicenses.some((license) => sbomLicenses.includes(license))
      ) {
        throw new Error(`${identity(component)} SBOM license is missing package metadata license`)
      }
    }
    if (sbomLicenses.length === 0 && !workspaceRefs.has(component['bom-ref'])) {
      warningInventory.push({
        code: 'missing-license',
        component: identity(component),
        version: component.version,
        ref: component['bom-ref']
      })
    }
  }
  warningInventory.sort((left, right) => left.ref.localeCompare(right.ref))

  if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length === 0) {
    throw new Error('SBOM dependency edges are required')
  }
  const dependencyByRef = new Map()
  for (const entry of sbom.dependencies) {
    if (typeof entry?.ref !== 'string' || dependencyByRef.has(entry.ref)) {
      throw new Error('SBOM dependency references must be unique')
    }
    if (!byRef.has(entry.ref) || !Array.isArray(entry.dependsOn)) {
      throw new Error('SBOM dependency edges must reference components')
    }
    for (const target of entry.dependsOn) {
      if (!byRef.has(target)) throw new Error(`SBOM dependency target is absent: ${target}`)
    }
    dependencyByRef.set(entry.ref, entry)
  }

  const expected = expectedDependencyRefs(packages, byIdentity)
  const rootRef = [...workspaceRefs.entries()].find(
    ([, entry]) => entry.manifest.name === rootManifest.name
  )?.[0]
  if (!rootRef || !dependencyByRef.has(rootRef))
    throw new Error('Root workspace dependency edge is missing')
  for (const [name, refs] of expected) {
    const ref = [...workspaceRefs.entries()].find(([, entry]) => entry.manifest.name === name)?.[0]
    if (!ref || !dependencyByRef.has(ref)) throw new Error(`Dependency edge is missing for ${name}`)
    const actual = new Set(dependencyByRef.get(ref).dependsOn)
    for (const target of refs) {
      if (!actual.has(target)) throw new Error(`Dependency edge ${name} -> ${target} is missing`)
    }
  }

  return { warningInventory }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const sbomPath = resolve(process.argv[2] ?? '')
  const expectedVersion = process.argv[3] ?? readJson(join(repositoryRoot, 'package.json')).version
  if (!process.argv[2]) throw new Error('Usage: verify-sbom.mjs <sbom-path> [version] [--json]')
  const result = verifySbom(sbomPath, expectedVersion)
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    process.stdout.write(
      `[verify-sbom] OK: ${basename(sbomPath)} CycloneDX 1.7 warnings=${result.warningInventory.length}\n`
    )
  }
}
