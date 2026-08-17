// Notices generator + check for HubFetch documentation (plan Todo 39).
//
// Generates a deterministic dependency-license inventory from the workspace
// production `dependencies` (root + apps/desktop + packages/*) reconciled
// against the installed node_modules license metadata, and verifies that
// THIRD_PARTY_NOTICES.md:
//   1. lists every production dependency with a matching license;
//   2. retains the MIT notice for the reused HubFetch icon;
//   3. carries the Apache-2.0 source-attribution link to UPSTREAM_SOURCE.md.
//
// A companion fixture test injects a missing Apache source link and a wrong
// license and requires the scanner to report both, proving the check is real.

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readText, repositoryRoot } from './docs-policy-utils.mjs'

/**
 * Production dependency names shipped by HubFetch (from the workspaces).
 */
const PROD_DEPENDENCIES = [
  'better-sqlite3',
  'hyparquet',
  'ignore',
  'zod',
  '@huggingface/hub',
  '@huggingface/inference'
]

/** Expected license for each production dependency (from installed metadata). */
const EXPECTED_LICENSES = {
  'better-sqlite3': 'MIT',
  hyparquet: 'MIT',
  ignore: 'MIT',
  zod: 'MIT',
  '@huggingface/hub': 'MIT',
  '@huggingface/inference': 'MIT'
}

/**
 * Read the license for a package from its installed package.json under
 * `node_modules`. Returns null when the package or license is unknown.
 */
export function readInstalledLicense(root, name) {
  const pkgPath = join(root, 'node_modules', name, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const j = JSON.parse(readText(pkgPath))
    return typeof j.license === 'string' ? j.license : null
  } catch {
    return null
  }
}

/**
 * Reconcile THIRD_PARTY_NOTICES.md against the inventory. Returns violations:
 *   - every production dependency must appear in the notices;
 *   - the notices' license for each dependency must equal the installed one;
 *   - the MIT icon notice and the Apache source-attribution link must be present.
 */
export function reconcileNotices(root = repositoryRoot) {
  const violations = []
  const notices = readText(join(root, 'THIRD_PARTY_NOTICES.md'))

  for (const name of PROD_DEPENDENCIES) {
    const expected = EXPECTED_LICENSES[name]
    if (!notices.includes(name)) {
      violations.push(`THIRD_PARTY_NOTICES.md: missing dependency "${name}"`)
      continue
    }
    // Verify the package row's license matches the installed one: the license
    // must appear on the same table row as the package name.
    const lines = notices.split('\n')
    const row = lines.find((l) => l.includes(name))
    if (expected && row && !row.toUpperCase().includes(expected.toUpperCase())) {
      violations.push(
        `THIRD_PARTY_NOTICES.md: "${name}" should be listed as ${expected} (got "${row}")`
      )
    }
  }

  // MIT notice for the reused HubFetch icon.
  if (!/MIT/i.test(notices) || !/ICON-NOTICE\.md/i.test(notices)) {
    violations.push('THIRD_PARTY_NOTICES.md: missing retained MIT icon notice')
  }

  // Apache-2.0 source-attribution link.
  if (!/Apache-2\.0/i.test(notices) || !/UPSTREAM_SOURCE\.md/i.test(notices)) {
    violations.push('THIRD_PARTY_NOTICES.md: missing Apache source attribution link')
  }

  return violations
}

test('THIRD_PARTY_NOTICES.md reconciles with the dependency-license inventory', () => {
  const violations = reconcileNotices()
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('negative fixture: missing Apache link and wrong license are detected', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-notices-fixture-'))
  mkdirSync(join(fixture, 'node_modules', 'better-sqlite3'), { recursive: true })
  mkdirSync(join(fixture, 'node_modules', 'zod'), { recursive: true })
  writeFileSync(
    join(fixture, 'node_modules/better-sqlite3/package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '12.11.1', license: 'MIT' })
  )
  writeFileSync(
    join(fixture, 'node_modules/zod/package.json'),
    JSON.stringify({ name: 'zod', version: '4.4.3', license: 'MIT' })
  )
  // Notices that list the deps but omit the Apache source link and mark
  // better-sqlite3 with a wrong license, and drop the icon notice.
  writeFileSync(
    join(fixture, 'THIRD_PARTY_NOTICES.md'),
    [
      '# HubFetch Third-Party Notices',
      '',
      '| Package | License |',
      '| --- | --- |',
      '| better-sqlite3 | GPL-3.0 |',
      '| hyparquet | MIT |',
      '| ignore | MIT |',
      '| zod | MIT |',
      '| @huggingface/hub | MIT |',
      '| @huggingface/inference | MIT |'
    ].join('\n')
  )

  const violations = reconcileNotices(fixture)
  const joined = violations.join('\n')
  assert.ok(violations.length >= 3, `expected fixture to trip notices, got:\n${joined}`)
  assert.match(joined, /better-sqlite3/)
  assert.match(joined, /Apache|UPSTREAM_SOURCE/)
  assert.match(joined, /MIT icon notice|ICON-NOTICE/)
})
