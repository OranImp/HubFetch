// Shared helpers for the HubFetch documentation policy tests (pnpm test:docs).
//
// These helpers are intentionally side-effect free and operate on a `root`
// argument so both the real-repo scan and the disposable negative fixtures can
// reuse them (the same pattern as scripts/no-updater.test.mjs).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Walk a directory depth-first, invoking onFile for each regular file. */
export function walk(dir, onFile) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.venv') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

/** Collect every markdown file under root (excluding node_modules/.git/.venv). */
export function collectMarkdown(root) {
  const files = []
  walk(root, (file) => {
    if (file.endsWith('.md')) files.push(file)
  })
  return files
}

/** Read a file as UTF-8; returns '' if it does not exist. */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** All markdown link destinations `[text](dest)` in a document. */
export function extractMarkdownLinks(content) {
  const links = []
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = re.exec(content)) !== null) {
    links.push(m[1])
  }
  return links
}

/**
 * Banned claims that must not appear in current-product documentation
 * (everything except the historical changelog). Each entry is matched as a
 * case-insensitive substring. Only documents that describe the CURRENT product
 * are scanned; provenance/reference documents (which legitimately describe
 * history and absence) are exempt.
 */
export const BANNED_CLAIMS = [
  'PySide6',
  'PyInstaller',
  'PyQt',
  'pyside',
  'python 3',
  'installer',
  'self-update',
  'auto-update',
  'electron-updater',
  'updater',
  'AppImage',
  '.dmg',
  '.deb',
  'macOS build',
  'Linux build',
  'multi-platform',
  'cross-platform',
  'huggingface-cli',
  'one-task-at-a-time global FIFO',
  'global FIFO',
  'Windows Credential Manager'
]

/**
 * Relative paths (POSIX) that are exempt from the banned-claims scan. These
 * documents must discuss history, provenance, or absence and therefore
 * legitimately mention the banned terms.
 */
const BANNED_CLAIM_EXEMPT = new Set([
  'docs/changelog.md',
  'UPSTREAM_SOURCE.md',
  'docs/upstream-sync.md',
  'THIRD_PARTY_NOTICES.md'
])

/** Negation words that mark a line as describing the ABSENCE of a claim. */
const NEGATIONS = [
  'no ',
  'never ',
  'not ',
  'does not',
  'do not',
  'without ',
  'no-',
  'absence',
  'removed',
  'removal',
  'rejecting',
  'rejects',
  'reintroduce',
  'intentionally removed',
  'no self-update'
]

/**
 * Scan a markdown file for banned claims that are stated as current behavior.
 * Lines that contain a negation word (e.g. "no auto-updater") are treated as
 * describing absence and are skipped; a negation on the surrounding lines also
 * suppresses the flag (handles line-wrapped "no updater"). Provenance and
 * reference documents are exempt. Returns `rel:line: claim` violations.
 */
export function scanBannedClaims(file, root) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (BANNED_CLAIM_EXEMPT.has(rel)) return []
  const content = readText(file)
  const violations = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase()
    const context = `${lines[i - 1] ?? ''} ${lines[i]} ${lines[i + 1] ?? ''}`.toLowerCase()
    for (const claim of BANNED_CLAIMS) {
      const c = claim.toLowerCase()
      if (!lower.includes(c)) continue
      const negated = NEGATIONS.some((n) => context.includes(n))
      if (negated) continue
      violations.push(`${rel}:${i + 1}: banned current-product claim "${claim}"`)
    }
  }
  return violations
}
