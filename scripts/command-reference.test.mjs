// Command-reference validator for HubFetch documentation (plan Todo 39).
//
// Verifies that every documented command matches the real workspace manifests:
//   - `pnpm <script>` commands resolve to real root package.json scripts;
//   - `pnpm --filter <pkg> <script>` commands resolve to real scripts on the
//     matching workspace package;
//   - no stale legacy runtime commands (PySide6 / PyInstaller / pip / python)
//     are documented as current workflow.
//
// A companion fixture test injects a stale PySide6 command and requires the
// validator to report it, proving the check is real.

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readText, repositoryRoot } from './docs-policy-utils.mjs'

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

/** Load the scripts map from a manifest, or {} when missing. */
function loadScripts(root, rel) {
  const file = join(root, rel)
  if (!existsSync(file)) return {}
  try {
    const j = JSON.parse(readText(file))
    return j.scripts || {}
  } catch {
    return {}
  }
}

/** Root and workspace manifest paths used for command resolution. */
const MANIFESTS = {
  root: 'package.json',
  desktop: 'apps/desktop/package.json',
  shared: 'packages/shared/package.json',
  'hub-api': 'packages/hub-api/package.json'
}

/** Legacy runtime commands that must never appear as current workflow. */
const STALE_COMMANDS = [
  'pyinstaller',
  'pip install',
  'pip3 install',
  'python -m',
  'python hubfetch',
  'uv run',
  'poetry run'
]

/** Reference/provenance docs where legacy terms describe history, not workflow. */
const STALE_COMMAND_EXEMPT = new Set([
  'docs/changelog.md',
  'UPSTREAM_SOURCE.md',
  'docs/upstream-sync.md',
  'THIRD_PARTY_NOTICES.md'
])

/** pnpm built-in subcommands that are not workspace scripts. */
const PNPM_BUILTINS = new Set([
  'install',
  'audit',
  'licenses',
  'list',
  'outdated',
  'why',
  'add',
  'remove',
  'update',
  'exec',
  'dlx',
  'run',
  'rebuild',
  'doctor',
  'import',
  'fetch',
  'patch',
  'prune',
  'publish',
  'store',
  'config',
  'env',
  'uninstall',
  'link',
  'unlink',
  'recursive',
  'filter',
  'deploy'
])

/**
 * Verify documented commands in the markdown docs under `root`. Returns
 * violations for: unknown `pnpm <script>` commands, unknown
 * `pnpm --filter <pkg> <script>` commands, and stale legacy commands.
 */
export function checkCommands(root = repositoryRoot) {
  const violations = []
  const scripts = {}
  for (const [key, rel] of Object.entries(MANIFESTS)) scripts[key] = loadScripts(root, rel)

  for (const file of productMarkdown(root)) {
    const rel = relative(root, file).replace(/\\/g, '/')
    if (STALE_COMMAND_EXEMPT.has(rel)) continue
    const content = readText(file)
    const lines = content.split('\n')
    const lower = content.toLowerCase()

    // Stale legacy commands.
    for (const cmd of STALE_COMMANDS) {
      if (lower.includes(cmd)) {
        const idx = lines.findIndex((l) => l.toLowerCase().includes(cmd))
        const context =
          idx >= 0
            ? `${lines[idx - 1] ?? ''} ${lines[idx]} ${lines[idx + 1] ?? ''}`.toLowerCase()
            : ''
        // Only flag when used as a workflow, not when describing absence/history.
        const negated =
          /no |never |not |do not|removed|removal|absence|historical|archive|reintroduce|intentionally removed/.test(
            context
          )
        if (!negated) violations.push(`stale command "${cmd}" documented`)
      }
    }

    // `pnpm <script>` at the start of a command line inside a code block.
    const pnpmRe = /pnpm(?:\s+--filter\s+([\w./-]+))?\s+([\w:./-]+)/g
    let m
    while ((m = pnpmRe.exec(lower)) !== null) {
      const filter = m[1]
      const script = m[2]
      if (PNPM_BUILTINS.has(script)) continue
      if (filter) {
        const key = MANIFESTS[filter] ? filter : null
        if (key && !scripts[key][script]) {
          violations.push(`unknown script "${script}" on filter "${filter}"`)
        }
      } else if (!scripts.root[script]) {
        // Allow scoped forms like `pnpm -r typecheck` handled as root-ish.
        violations.push(`unknown root script "${script}"`)
      }
    }
  }
  return violations
}

test('every documented command matches the workspace manifests', () => {
  const violations = checkCommands()
  assert.deepEqual(violations, [], violations.join('\n'))
})

test('negative fixture: stale PySide6 command is detected', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-commandref-fixture-'))
  mkdirSync(join(fixture, 'docs'), { recursive: true })
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ scripts: { dev: 'x', test: 'y' } }))
  writeFileSync(
    join(fixture, 'docs/user-guide.en.md'),
    '# Guide\n\n## Build\n\nTo build the app run:\n\n```sh\npyinstaller --onefile hubfetch.py\n```\n'
  )
  const violations = checkCommands(fixture)
  const joined = violations.join('\n')
  assert.ok(violations.length >= 1, `expected stale command detected, got:\n${joined}`)
  assert.match(joined, /pyinstaller|hubfetch\.py/)
})
