import { describe, expect, it } from 'vitest'
import { ipcRequestSchemas, settingsExportFileSchema } from '@hubfetch/shared'

/**
 * The IPC request schemas are the input-validation boundary for the main
 * process. These guard the security-relevant refinements: destructive
 * confirmations must match, and slugs/repo ids that are interpolated raw into
 * Hub API paths must not carry traversal segments.
 */
describe('ipcRequestSchemas', () => {
  it('rejects a collection slug with a dot-only owner segment (path traversal)', () => {
    const schema = ipcRequestSchemas['hub:collection']!
    // A well-formed slug parses.
    expect(schema.safeParse({ slug: 'nvidia/cosmos-69ab2f273c55ae147e43c342' }).success).toBe(true)
    // "../victim-<24hex>" would resolve to /api/victim under /api/collections/.
    expect(schema.safeParse({ slug: '../deadbeefdeadbeefdeadbeef' }).success).toBe(false)
    expect(schema.safeParse({ slug: '../secret-69ab2f273c55ae147e43c342' }).success).toBe(false)
  })

  it('requires the delete confirmation to match the target', () => {
    const collection = ipcRequestSchemas['hub:collectionDelete']!
    const slug = 'me/keep-69ab2f273c55ae147e43c342'
    expect(collection.safeParse({ slug, confirmSlug: slug }).success).toBe(true)
    expect(collection.safeParse({ slug, confirmSlug: 'wrong' }).success).toBe(false)

    const repo = ipcRequestSchemas['hub:repoDelete']!
    expect(repo.safeParse({ kind: 'model', repoId: 'me/x', confirmName: 'me/x' }).success).toBe(
      true
    )
    expect(repo.safeParse({ kind: 'model', repoId: 'me/x', confirmName: 'me/y' }).success).toBe(
      false
    )
  })

  it('accepts non-hex notification ids for mark-as-read (post/paper ids are plain strings)', () => {
    const schema = ipcRequestSchemas['hub:notificationsMarkRead']!
    expect(schema.safeParse({ discussionIds: [], read: true }).success).toBe(true)
    expect(
      schema.safeParse({ discussionIds: ['post-abc_123', 'paper.2301'], read: true }).success
    ).toBe(true)
  })

  it('bounds hub:fileRange windows so a renderer cannot request a multi-GB slice', () => {
    const schema = ipcRequestSchemas['hub:fileRange']!
    const base = { kind: 'dataset', repoId: 'me/ds', path: 'data/train.parquet' }
    // A normal footer/row read passes.
    expect(schema.safeParse({ ...base, start: 0, end: 512 * 1024 }).success).toBe(true)
    // A huge window (the OOM vector) is rejected.
    expect(schema.safeParse({ ...base, start: 0, end: 10_000_000_000 }).success).toBe(false)
    // Inverted ranges are rejected.
    expect(schema.safeParse({ ...base, start: 100, end: 50 }).success).toBe(false)
    // Path traversal is rejected by relPath.
    expect(schema.safeParse({ ...base, path: '../secret', start: 0, end: 10 }).success).toBe(false)
  })

  it('accepts privacy:clearLocalData with optional signOut', () => {
    const schema = ipcRequestSchemas['privacy:clearLocalData']!
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ signOut: true }).success).toBe(true)
    expect(schema.safeParse({ signOut: 'yes' }).success).toBe(false)
    expect(schema.safeParse({ favorites: true, history: false, downloads: true }).success).toBe(
      true
    )
  })

  it('accepts personalization settings patches and rejects out-of-range fontScale', () => {
    const schema = ipcRequestSchemas['settings:set']!
    expect(
      schema.safeParse({
        patch: {
          uiDensity: 'compact',
          accent: 'violet',
          fontScale: 110,
          sidebarCollapsed: true,
          browsePageSize: 50,
          repoOpenTarget: 'browser',
          historyLimit: 100
        }
      }).success
    ).toBe(true)
    expect(schema.safeParse({ patch: { fontScale: 80 } }).success).toBe(false)
    expect(schema.safeParse({ patch: { browsePageSize: 25 } }).success).toBe(false)
    expect(schema.safeParse({ patch: { accent: 'pink' } }).success).toBe(false)
    expect(schema.safeParse({ patch: { hfCacheDir: '/tmp/renderer-controlled' } }).success).toBe(
      false
    )
  })

  it('accepts a version-1 settings export envelope', () => {
    expect(
      settingsExportFileSchema.safeParse({
        version: 1,
        exportedAt: '2026-07-11T00:00:00.000Z',
        settings: { theme: 'dark', fontScale: 110 }
      }).success
    ).toBe(true)
    expect(
      settingsExportFileSchema.safeParse({
        version: 2,
        exportedAt: '2026-07-11T00:00:00.000Z',
        settings: {}
      }).success
    ).toBe(false)
  })

  it('accepts hubEndpoint http(s) URLs or null', () => {
    const schema = ipcRequestSchemas['settings:set']!
    expect(schema.safeParse({ patch: { hubEndpoint: 'https://hf-mirror.com' } }).success).toBe(true)
    expect(schema.safeParse({ patch: { hubEndpoint: null } }).success).toBe(true)
    expect(schema.safeParse({ patch: { hubEndpoint: 'ftp://bad.example' } }).success).toBe(false)
    // The legacy nullable proxyUrl field is gone: strict mode rejects it.
    expect(schema.safeParse({ patch: { proxyUrl: 'http://127.0.0.1:7890' } }).success).toBe(false)
  })

  it('accepts all three closed proxy modes in settings patches', () => {
    const schema = ipcRequestSchemas['settings:set']!
    expect(
      schema.safeParse({ patch: { proxy: { mode: 'system', manualUrl: null } } }).success
    ).toBe(true)
    expect(
      schema.safeParse({ patch: { proxy: { mode: 'direct', manualUrl: null } } }).success
    ).toBe(true)
    expect(
      schema.safeParse({
        patch: { proxy: { mode: 'manual', manualUrl: 'http://127.0.0.1:7897' } }
      }).success
    ).toBe(true)
    // manualUrl is retained across mode switches.
    expect(
      schema.safeParse({
        patch: { proxy: { mode: 'system', manualUrl: 'http://127.0.0.1:7897' } }
      }).success
    ).toBe(true)
  })

  it('rejects unknown proxy modes, bare strings, and missing manual URLs', () => {
    const schema = ipcRequestSchemas['settings:set']!
    // Unknown mode: the union is closed — no fallback branch.
    expect(
      schema.safeParse({ patch: { proxy: { mode: 'automatic', manualUrl: null } } }).success
    ).toBe(false)
    // A nullable string is NOT a mode.
    expect(schema.safeParse({ patch: { proxy: null } }).success).toBe(false)
    expect(schema.safeParse({ patch: { proxy: 'http://127.0.0.1:7897' } }).success).toBe(false)
    // Manual mode requires a concrete URL.
    expect(
      schema.safeParse({ patch: { proxy: { mode: 'manual', manualUrl: null } } }).success
    ).toBe(false)
  })

  it('rejects credential-bearing and malformed manual proxy URLs', () => {
    const schema = ipcRequestSchemas['settings:set']!
    const manual = (manualUrl: string) => ({ patch: { proxy: { mode: 'manual', manualUrl } } })
    // Valid normalized host:port forms.
    expect(schema.safeParse(manual('http://127.0.0.1:7897')).success).toBe(true)
    expect(schema.safeParse(manual('https://proxy.example.com:8443')).success).toBe(true)
    expect(schema.safeParse(manual('http://[::1]:7897')).success).toBe(true)
    // Rejected: credentials, wrong protocol, path, query, fragment, missing port, malformed.
    for (const bad of [
      'http://user:pass@127.0.0.1:7897',
      'http://user@127.0.0.1:7897',
      'ftp://127.0.0.1:7897',
      'socks5://127.0.0.1:7897',
      'http://127.0.0.1:7897/path',
      'http://127.0.0.1:7897?x=1',
      'http://127.0.0.1:7897#frag',
      'http://127.0.0.1',
      '127.0.0.1:7897',
      'not-a-url',
      'http://127.0.0.1:0',
      'http://127.0.0.1:99999'
    ]) {
      expect(schema.safeParse(manual(bad)).success).toBe(false)
    }
  })

  it('accepts downloads:start proxy overrides for all three modes and rejects unknown ones', () => {
    const schema = ipcRequestSchemas['downloads:start']!
    const request = { repoId: 'org/repo', kind: 'model' }
    expect(schema.safeParse({ request: { ...request, proxy: { mode: 'system' } } }).success).toBe(
      true
    )
    expect(schema.safeParse({ request: { ...request, proxy: { mode: 'direct' } } }).success).toBe(
      true
    )
    expect(
      schema.safeParse({
        request: { ...request, proxy: { mode: 'manual', url: 'http://127.0.0.1:7897' } }
      }).success
    ).toBe(true)
    // Credential-bearing override is rejected before it can reach the manager.
    expect(
      schema.safeParse({
        request: { ...request, proxy: { mode: 'manual', url: 'http://user:pass@127.0.0.1:7897' } }
      }).success
    ).toBe(false)
    expect(schema.safeParse({ request: { ...request, proxy: { mode: 'auto' } } }).success).toBe(
      false
    )
    expect(schema.safeParse({ request: { ...request, proxy: { mode: 'manual' } } }).success).toBe(
      false
    )
  })

  it('accepts mode-aware proxy overrides for network:testConnection', () => {
    const schema = ipcRequestSchemas['network:testConnection']!
    // Omitted body = probe the applied settings (system/manual as persisted).
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(true)
    // All three closed override modes are valid draft selections.
    expect(schema.safeParse({ proxy: { mode: 'system' } }).success).toBe(true)
    expect(schema.safeParse({ proxy: { mode: 'direct' } }).success).toBe(true)
    expect(
      schema.safeParse({ proxy: { mode: 'manual', url: 'http://127.0.0.1:7897' } }).success
    ).toBe(true)
    // Endpoint drafts still follow the http(s)/null rule.
    expect(schema.safeParse({ endpoint: 'https://hf-mirror.com' }).success).toBe(true)
    expect(schema.safeParse({ endpoint: null, proxy: { mode: 'direct' } }).success).toBe(true)
    expect(schema.safeParse({ endpoint: 'ftp://bad.example' }).success).toBe(false)
  })

  it('rejects non-closed or credential-bearing proxy drafts for network:testConnection', () => {
    const schema = ipcRequestSchemas['network:testConnection']!
    // A free-form mode string is never accepted.
    expect(schema.safeParse({ proxy: { mode: 'auto' } }).success).toBe(false)
    expect(schema.safeParse({ proxy: { mode: 'manual' } }).success).toBe(false)
    expect(schema.safeParse({ proxy: 'http://127.0.0.1:7897' }).success).toBe(false)
    // Credentials in a manual draft URL are rejected before any probe.
    expect(
      schema.safeParse({ proxy: { mode: 'manual', url: 'http://user:pass@127.0.0.1:7897' } })
        .success
    ).toBe(false)
    // The legacy nullable proxyUrl field is gone; strict mode rejects it.
    expect(schema.safeParse({ proxyUrl: 'http://127.0.0.1:7897' }).success).toBe(false)
    // Direct/System drafts must not smuggle a URL.
    expect(
      schema.safeParse({ proxy: { mode: 'direct', url: 'http://127.0.0.1:7897' } }).success
    ).toBe(false)
  })

  it('accepts hub quicksearch query channels and rejects empty/oversized', () => {
    for (const channel of [
      'hub:searchOrgs',
      'hub:searchPapers',
      'hub:searchCollections'
    ] as const) {
      const schema = ipcRequestSchemas[channel]!
      expect(schema.safeParse({ query: 'meta' }).success).toBe(true)
      expect(schema.safeParse({ query: '' }).success).toBe(false)
      expect(schema.safeParse({ query: 'x'.repeat(65) }).success).toBe(false)
    }
  })
})
