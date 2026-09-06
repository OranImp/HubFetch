#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = rootManifest.version
const versionPattern = /^\d+\.\d+\.\d+$/

if (!versionPattern.test(version ?? '')) throw new Error('Root package.json has an invalid version')

const outputRelative = `artifacts/release/HubFetch-${version}.cdx.json`
const outputPath = join(root, outputRelative)
mkdirSync(dirname(outputPath), { recursive: true })
const splitDirectory = mkdtempSync(join(tmpdir(), 'hubfetch-sbom-'))

function runPnpm(args) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  }
}

function componentIdentity(component) {
  return [component.group, component.name].filter(Boolean).join('/')
}

function mergeDependency(dependencies, entry) {
  const existing = dependencies.get(entry.ref)
  if (!existing) {
    dependencies.set(entry.ref, {
      ref: entry.ref,
      dependsOn: [...new Set(entry.dependsOn ?? [])].sort()
    })
    return
  }
  existing.dependsOn = [...new Set([...existing.dependsOn, ...(entry.dependsOn ?? [])])].sort()
}

function addWorkspaceEdges(sbom, manifests) {
  const components = [sbom.metadata.component, ...sbom.components]
  const refsByIdentity = new Map(
    components.map((component) => [
      `${componentIdentity(component)}@${component.version}`,
      component['bom-ref']
    ])
  )
  const dependencies = new Map((sbom.dependencies ?? []).map((entry) => [entry.ref, entry]))
  const workspaceNames = new Set(manifests.map((manifest) => manifest.name))

  for (const manifest of manifests) {
    const sourceRef = refsByIdentity.get(`${manifest.name}@${manifest.version}`)
    if (!sourceRef) continue
    const targets = new Set()
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (field === 'devDependencies' && !workspaceNames.has(name)) continue
        const targetRef = refsByIdentity.get(
          `${name}@${manifests.find((item) => item.name === name)?.version ?? ''}`
        )
        if (targetRef) targets.add(targetRef)
      }
    }
    const entry = dependencies.get(sourceRef) ?? { ref: sourceRef, dependsOn: [] }
    entry.dependsOn = [...(manifest.name === manifests[0].name ? [] : entry.dependsOn), ...targets]
      .filter((ref, index, refs) => refs.indexOf(ref) === index)
      .sort()
    dependencies.set(sourceRef, entry)
  }
  sbom.dependencies = [...dependencies.values()].sort((left, right) =>
    left.ref.localeCompare(right.ref)
  )
}

const manifestPaths = [
  'package.json',
  'apps/desktop/package.json',
  'packages/shared/package.json',
  'packages/hub-api/package.json'
]
const manifests = manifestPaths.map((path) => JSON.parse(readFileSync(join(root, path), 'utf8')))

try {
  runPnpm(['sbom', '--prod', '--sbom-format', 'cyclonedx', '--out', outputRelative, '--silent'])

  const splitPattern = join(splitDirectory, 'sbom-%s-%v.cdx.json')
  runPnpm([
    'sbom',
    '--prod',
    '--sbom-format',
    'cyclonedx',
    '--split',
    '--out',
    splitPattern,
    '--silent'
  ])

  const rootSbom = JSON.parse(readFileSync(outputPath, 'utf8'))
  const documents = readdirSync(splitDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(splitDirectory, name), 'utf8')))
  const componentRefs = new Set([
    rootSbom.metadata.component['bom-ref'],
    ...rootSbom.components.map((component) => component['bom-ref'])
  ])
  const components = [...rootSbom.components]
  const dependencies = new Map((rootSbom.dependencies ?? []).map((entry) => [entry.ref, entry]))

  for (const document of documents) {
    const metadataComponent = document.metadata.component
    if (!componentRefs.has(metadataComponent['bom-ref'])) {
      components.push(metadataComponent)
      componentRefs.add(metadataComponent['bom-ref'])
    }
    for (const component of document.components ?? []) {
      if (componentRefs.has(component['bom-ref'])) continue
      components.push(component)
      componentRefs.add(component['bom-ref'])
    }
    for (const entry of document.dependencies ?? []) mergeDependency(dependencies, entry)
  }

  rootSbom.components = components.sort((left, right) =>
    left['bom-ref'].localeCompare(right['bom-ref'])
  )
  rootSbom.dependencies = [...dependencies.values()].sort((left, right) =>
    left.ref.localeCompare(right.ref)
  )
  addWorkspaceEdges(rootSbom, manifests)
  writeFileSync(outputPath, `${JSON.stringify(rootSbom, null, 2)}\n`, 'utf8')
  process.stdout.write(`[generate-sbom] ${outputRelative}\n`)
} finally {
  if (existsSync(splitDirectory)) rmSync(splitDirectory, { recursive: true, force: true })
}
