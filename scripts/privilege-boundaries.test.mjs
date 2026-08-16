// Negative policy test for the Electron privilege-boundary enforcement
// (plan Todo 18). Verifies, by textual/AST-equivalent scan:
//
//   1. Every `ipcMain.handle` / `ipcMain.on` registration in the main process
//      goes through the central wrapper in apps/desktop/src/main/ipc.ts, which
//      itself calls the shared sender-trust boundary (checkSenderTrust). No
//      channel can bypass the wrapper (a future handler can only be added by
//      extending the central function).
//   2. The production CSP (source index.html) contains no scheme-source
//      wildcard (`https:`, `http:`, bare `*`) — scoped subdomain wildcards
//      pinned to the app's own embeddable domains are the only ones allowed —
//      and keeps object-src/base-uri locked to 'none'.
//
// A companion test feeds the scanner a disposable fixture with a raw
// `ipcMain.handle('hub:search', ...)` and a CSP carrying `img-src https:` and
// requires both to be detected.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE_EXT = /\.(ts|tsx|mjs|js|cjs)$/

function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

/**
 * Every `ipcMain.handle` / `ipcMain.on` registration under `root`, as
 * `rel:line: api`. An empty array means zero direct registrations.
 */
export function findIpcMainRegistrations(root = repositoryRoot) {
  const violations = []
  const mainDir = join(root, 'apps/desktop/src/main')
  if (!existsSync(mainDir)) return violations
  walk(mainDir, (file) => {
    if (!SOURCE_EXT.test(file)) return
    const content = readFileSync(file, 'utf8')
    for (const match of content.matchAll(/ipcMain\.(handle|on)\(/g)) {
      const line = content.slice(0, match.index).split('\n').length
      const rel = relative(root, file).replace(/\\/g, '/')
      violations.push(`${rel}:${line}: ipcMain.${match[1]}(`)
    }
  })
  return violations
}

function readIndexHtml(root) {
  const path = join(root, 'apps/desktop/src/renderer/index.html')
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Parse the CSP `content` from the renderer's index.html, or null. */
export function cspContent(html) {
  const match = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i.exec(html)
  return match ? match[1] : null
}

/** Scheme-source wildcard tokens present in a CSP, as `directive:token` pairs. */
export function cspWildcardTokens(csp) {
  return csp.split(';').flatMap((directive) => {
    const [name, ...tokens] = directive.trim().split(/\s+/)
    if (!name) return []
    return tokens
      .filter((token) => token === '*' || /^(?:https?|wss?|ftp):$/.test(token))
      .map((token) => `${name}:${token}`)
  })
}

test('all ipcMain registrations go through the central sender-trust wrapper', () => {
  const registrations = findIpcMainRegistrations()
  // Exactly one registration site: the wrapper's single ipcMain.handle call in
  // apps/desktop/src/main/ipc.ts. No ipcMain.on, no direct handlers anywhere.
  assert.equal(registrations.length, 1, registrations.join('\n'))
  assert.match(registrations[0] ?? '', /^apps\/desktop\/src\/main\/ipc\.ts:\d+: ipcMain\.handle\($/)
  assert.ok(!registrations[0]?.includes('ipcMain.on('))

  const wrapper = readFileSync(join(repositoryRoot, 'apps/desktop/src/main/ipc.ts'), 'utf8')
  assert.match(wrapper, /checkSenderTrust/, 'wrapper must enforce the sender-trust boundary')
  assert.match(
    wrapper,
    /ipcMain\.handle\(channel, async \(event, payload: unknown\)/,
    'wrapper must remain the single privileged-entry gate'
  )
})

test('production CSP has no scheme-source wildcards and locks object/base-uri to none', () => {
  const html = readIndexHtml(repositoryRoot)
  assert.ok(html, 'renderer index.html must exist')
  const csp = cspContent(html)
  assert.ok(csp, 'renderer index.html must carry a CSP meta tag')
  assert.deepEqual(
    cspWildcardTokens(csp),
    [],
    `wildcards found: ${cspWildcardTokens(csp).join(', ')}`
  )
  assert.ok(csp.includes("object-src 'none'"), "object-src 'none' required")
  assert.ok(csp.includes("base-uri 'none'"), "base-uri 'none' required")
  assert.match(csp, /script-src 'self'/, "script-src 'self' required")
})

test('negative fixture: raw ipcMain.handle and a wildcard CSP are both detected', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hubfetch-privileges-fixture-'))
  mkdirSync(join(fixture, 'apps/desktop/src/main'), { recursive: true })
  mkdirSync(join(fixture, 'apps/desktop/src/renderer'), { recursive: true })
  writeFileSync(
    join(fixture, 'apps/desktop/src/main/evil.ts'),
    "import { ipcMain } from 'electron'\n" +
      "ipcMain.handle('hub:search', () => ({ ok: true }))\n" +
      "ipcMain.on('evt:rogue', () => {})\n"
  )
  writeFileSync(
    join(fixture, 'apps/desktop/src/renderer/index.html'),
    '<meta http-equiv="Content-Security-Policy" ' +
      "content=\"default-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'\" />\n"
  )
  const registrations = findIpcMainRegistrations(fixture)
  assert.deepEqual(registrations, [
    'apps/desktop/src/main/evil.ts:2: ipcMain.handle(',
    'apps/desktop/src/main/evil.ts:3: ipcMain.on('
  ])
  const wildcards = cspWildcardTokens(
    cspContent(readFileSync(join(fixture, 'apps/desktop/src/renderer/index.html'), 'utf8'))
  )
  assert.deepEqual(wildcards, ['img-src:https:'])
})
