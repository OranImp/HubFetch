// Markdown link checker for HubFetch documentation (plan Todo 39).
//
// Scans every tracked markdown document and verifies that every relative link
// and image resolves to a real file. External URLs (http/https) and in-document
// anchors (#...) are skipped. It also verifies that the README carries the
// required independent/non-affiliation statement.
//
// A companion fixture test feeds the scanner a disposable doc tree with a
// broken link and a missing non-affiliation statement and requires both to be
// detected, proving the checker is real.

import { existsSync, readdirSync } from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readText, repositoryRoot } from './docs-policy-utils.mjs'

/** Docs roots scanned by the link checker: root *.md and docs/ only. */
const SCAN_DIRS = ['', 'docs']

const NON_AFFILIATION = 'not affiliated with'

/**
 * Return `rel: file -> broken link` for every relative link/image in the
 * product documentation (root *.md + docs/) that does not resolve to a real
 * file. Anchors (`#...`) and absolute/external URLs are ignored.
 */
export function checkMarkdownLinks(root = repositoryRoot) {
  const violations = []
  const files = []
  for (const dir of SCAN_DIRS) {
    const abs = dir ? join(root, dir) : root
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(abs, entry.name))
    }
  }
  for (const file of files) {
    const content = readText(file)
    const rel = relative(root, file).replace(/\\/g, '/')
    const re = /\[[^\]]*\]\(([^)]+)\)/g
    let m
    while ((m = re.exec(content)) !== null) {
      const raw = m[1].trim()
      if (!raw) continue
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue // external URL / scheme
      if (raw.startsWith('#')) continue // in-document anchor
      const dest = raw.split('#')[0]
      if (!dest) continue
      const target = resolve(dirname(file), dest)
      if (!existsSync(target)) {
        violations.push(`${rel}: -> "${raw}" (missing ${relative(root, target)})`)
      }
    }
  }
  return violations
}

/**
 * Return a violation if the README does not carry the independent/
 * non-affiliation statement.
 */
export function checkNonAffiliation(root = repositoryRoot) {
  const readme = readText(join(root, 'README.md'))
  if (!readme.toLowerCase().includes(NON_AFFILIATION)) {
    return ['README.md: missing independent/non-affiliation statement']
  }
  return []
}

test('every relative link/image in the documentation resolves', () => {
  const violations = checkMarkdownLinks()
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('README carries the independent/non-affiliation statement', () => {
  const violations = checkNonAffiliation()
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('negative fixture: broken link and missing non-affiliation are detected', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-docslink-fixture-'))
  mkdirSync(join(fixture, 'docs'), { recursive: true })
  writeFileSync(
    join(fixture, 'README.md'),
    '# HubFetch\n\nThis is a docs-policy fixture. See [guide](docs/user-guide.en.md).\n'
  )
  writeFileSync(
    join(fixture, 'docs/user-guide.en.md'),
    '# Guide\n\nOpen the [screenshot](screenshots/browse.png).\n'
  )
  const linkViolations = checkMarkdownLinks(fixture)
  assert.ok(
    linkViolations.length >= 1,
    `expected broken link detected, got:\n${linkViolations.join('\n')}`
  )
  assert.match(linkViolations.join('\n'), /screenshots\/browse\.png/)

  const nonAffiliation = checkNonAffiliation(fixture)
  assert.ok(nonAffiliation.length >= 1, 'expected missing non-affiliation statement detected')
  assert.match(nonAffiliation.join('\n'), /non-affiliation/)
})
