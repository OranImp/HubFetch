// Docs contract test for HubFetch documentation (plan Todo 39).
//
// Verifies that the required documentation set exists, that the paired English
// and Simplified-Chinese user guides share the required section structure, and
// that no banned current-product claim (Qt/PySide, PyInstaller, updater,
// installer, multi-platform, legacy auth) appears outside the historical
// changelog.
//
// A companion fixture test adds a stale PySide6 command and an updater claim to
// a disposable doc set and requires the scanner to report both.

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readText, repositoryRoot, scanBannedClaims } from './docs-policy-utils.mjs'

/** Documents that must exist at the repository root. */
const REQUIRED_ROOT_DOCS = [
  'README.md',
  'LICENSE',
  'UPSTREAM_SOURCE.md',
  'THIRD_PARTY_NOTICES.md',
  'CONTRIBUTING.md',
  'SECURITY.md'
]

/** Documents that must exist under docs/. */
const REQUIRED_DOCS = [
  'docs/user-guide.en.md',
  'docs/user-guide.zh-CN.md',
  'docs/architecture.md',
  'docs/security.md',
  'docs/troubleshooting.md',
  'docs/releasing.md',
  'docs/contributing.md',
  'docs/upstream-sync.md',
  'docs/changelog.md'
]

/**
 * Section headings (## / ###) that every user guide must contain. The English
 * and Chinese guides must both carry these; the contract checks the English
 * guide for the canonical headings and the Chinese guide for their translated
 * equivalents.
 */
const EN_GUIDE_SECTIONS = [
  'Overview',
  'Installing',
  'Signing in',
  'Browsing',
  'Downloading',
  'Cloning',
  'Proxies',
  'Diagnostics',
  'Notifications',
  'Settings',
  'Privacy',
  'Troubleshooting'
]

/** Chinese translations of the required guide sections. */
const ZH_GUIDE_SECTIONS = [
  '概述',
  '安装',
  '登录',
  '浏览',
  '下载',
  '克隆',
  '代理',
  '诊断',
  '通知',
  '设置',
  '隐私',
  '故障排除'
]

/** Return missing required files under root. */
export function missingRequiredDocs(root = repositoryRoot) {
  const missing = []
  for (const rel of [...REQUIRED_ROOT_DOCS, ...REQUIRED_DOCS]) {
    if (!existsSync(join(root, rel))) missing.push(rel)
  }
  return missing
}

function headings(content) {
  const out = []
  for (const line of content.split('\n')) {
    const m = /^#{2,3}\s+(.*)$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

/** Product markdown files: root *.md plus docs/*.md. */
function productMarkdown(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(root, entry.name))
  }
  const docs = join(root, 'docs')
  if (existsSync(docs)) {
    for (const entry of readdirSync(docs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(docs, entry.name))
    }
  }
  return files
}

/** Return guide sections missing from a guide file (by heading substring). */
export function missingGuideSections(file, root, required) {
  const content = readText(file)
  const present = headings(content).join('\n')
  return required.filter((s) => !present.toLowerCase().includes(s.toLowerCase()))
}

/** Run the full docs contract and return all violations as strings. */
export function runDocsContract(root = repositoryRoot) {
  const violations = []
  for (const rel of missingRequiredDocs(root)) {
    violations.push(`missing required document: ${rel}`)
  }
  const en = join(root, 'docs/user-guide.en.md')
  const zh = join(root, 'docs/user-guide.zh-CN.md')
  if (existsSync(en)) {
    for (const s of missingGuideSections(en, root, EN_GUIDE_SECTIONS)) {
      violations.push(`docs/user-guide.en.md: missing section "${s}"`)
    }
  }
  if (existsSync(zh)) {
    for (const s of missingGuideSections(zh, root, ZH_GUIDE_SECTIONS)) {
      violations.push(`docs/user-guide.zh-CN.md: missing section "${s}"`)
    }
  }
  // Banned current-product claims outside the historical changelog.
  for (const file of productMarkdown(root)) {
    for (const v of scanBannedClaims(file, root)) {
      violations.push(v)
    }
  }
  return violations
}

/** Manifest paths whose version must match the current changelog heading. */
const MANIFEST_PATHS = [
  'package.json',
  'packages/shared/package.json',
  'packages/hub-api/package.json',
  'apps/desktop/package.json'
]

test('all four workspace manifests match the changelog current-release heading', () => {
  const root = repositoryRoot
  const changelog = readText(join(root, 'docs/changelog.md'))
  const m = changelog.match(/^#{2,3}\s+(\d+\.\d+\.\d+)/m)
  assert.ok(m, 'could not find a version heading in docs/changelog.md')
  const expected = m[1]
  for (const rel of MANIFEST_PATHS) {
    const content = readFileSync(join(root, rel), 'utf8')
    const pkg = JSON.parse(content)
    assert.equal(
      pkg.version,
      expected,
      `${rel}: version ${pkg.version} does not match changelog current-release ${expected}`
    )
  }
})

test('required documentation set exists and guides are complete and clean', () => {
  const violations = runDocsContract()
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('negative fixture: stale PySide6 command and updater claim are detected', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-docscontract-fixture-'))
  mkdirSync(join(fixture, 'docs'), { recursive: true })
  // Minimal valid set so only the injected defects surface.
  for (const rel of [...REQUIRED_ROOT_DOCS, ...REQUIRED_DOCS]) {
    const file = join(fixture, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '# placeholder\n')
  }
  writeFileSync(
    join(fixture, 'docs/user-guide.en.md'),
    EN_GUIDE_SECTIONS.map((s) => `## ${s}\n`).join('') +
      '\n## Legacy\nTo run a PySide6 command use: `pyinstaller --onefile hubfetch.py`.\n'
  )
  writeFileSync(
    join(fixture, 'docs/user-guide.zh-CN.md'),
    ZH_GUIDE_SECTIONS.map((s) => `## ${s}\n`).join('') + '\n'
  )
  writeFileSync(
    join(fixture, 'README.md'),
    '# HubFetch\n\nThe app checks for updates automatically with an updater.\n'
  )

  const violations = runDocsContract(fixture)
  const joined = violations.join('\n')
  assert.ok(violations.length >= 2, `expected fixture to trip contract, got:\n${joined}`)
  assert.match(joined, /PySide6|pyinstaller|PyInstaller/i)
  assert.match(joined, /updater/i)
})
