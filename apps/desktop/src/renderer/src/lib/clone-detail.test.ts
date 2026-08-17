import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { CloneRecord } from '@hubfetch/shared'
import {
  cloneQueuePosition,
  compareCloneFifo,
  describeCloneAuth,
  describeClonePhase,
  describeCloneProxy,
  describeCloneRevision,
  findRetryParent,
  redactCloneText,
  serializeCloneDetails
} from './clone-detail'

// Mirrors the renderer's i18next mock: the key (or the key with interpolated
// values) is the truth, so assertions pin which locale keys the helpers reach.
const t = ((key: string, opts?: Record<string, unknown>) => {
  if (!opts) return key
  let out = key
  for (const [name, value] of Object.entries(opts)) out = out.replace(`{{${name}}}`, String(value))
  return out
}) as TFunction

function clone(overrides: Partial<CloneRecord> & { id: string }): CloneRecord {
  return {
    attempt: 1,
    repoKind: 'model',
    repoId: 'acme/model',
    revision: { kind: 'branch', name: 'main' },
    transport: 'https',
    destination: 'E:\\Repos\\model',
    auth: 'system',
    proxy: { mode: 'system' },
    status: 'queued',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides
  }
}

describe('compareCloneFifo', () => {
  it('orders by createdAt then id for deterministic FIFO', () => {
    const a = clone({
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-08-17T00:00:01.000Z'
    })
    const b = clone({
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-08-17T00:00:01.000Z'
    })
    const c = clone({
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    const sorted = [a, b, c].sort(compareCloneFifo)
    expect(sorted.map((r) => r.id)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ])
  })
})

describe('cloneQueuePosition', () => {
  const running = clone({
    id: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    createdAt: '2026-08-17T00:00:00.000Z'
  })
  const queued = clone({
    id: '22222222-2222-4222-8222-222222222222',
    status: 'queued',
    createdAt: '2026-08-17T00:00:01.000Z'
  })
  const cancelling = clone({
    id: '33333333-3333-4333-8333-333333333333',
    status: 'cancelling',
    createdAt: '2026-08-17T00:00:02.000Z'
  })
  const completed = clone({
    id: '44444444-4444-4444-8444-444444444444',
    status: 'completed',
    createdAt: '2026-08-17T00:00:03.000Z'
  })
  const records = [running, queued, cancelling, completed]

  it('positions only the non-terminal FIFO line 1-based', () => {
    expect(cloneQueuePosition(records, running.id)).toBe(1)
    expect(cloneQueuePosition(records, queued.id)).toBe(2)
    expect(cloneQueuePosition(records, cancelling.id)).toBe(3)
  })

  it('excludes terminal attempts and unknown ids', () => {
    expect(cloneQueuePosition(records, completed.id)).toBeNull()
    expect(cloneQueuePosition(records, 'missing')).toBeNull()
  })
})

describe('findRetryParent', () => {
  const parent = clone({
    id: '44444444-4444-4444-8444-444444444444',
    status: 'failed'
  })
  const child = clone({
    id: '11111111-1111-4111-8111-111111111111',
    status: 'queued',
    attempt: 2,
    retryOf: parent.id
  })

  it('links a retry attempt to its terminal parent when present', () => {
    expect(findRetryParent([parent, child], child)?.id).toBe(parent.id)
  })

  it('returns null without a retryOf link or when the parent is missing', () => {
    const fresh = clone({ id: '22222222-2222-4222-8222-222222222222' })
    expect(findRetryParent([parent, child], fresh)).toBeNull()
    expect(findRetryParent([child], child)).toBeNull()
  })
})

describe('describeCloneRevision', () => {
  it('describes branch, tag, commit, and default branch locally', () => {
    expect(describeCloneRevision(t, { kind: 'branch', name: 'main' })).toBe(
      'clones:revision.branch · main'
    )
    expect(describeCloneRevision(t, { kind: 'tag', name: 'v1.0' })).toBe(
      'clones:revision.tag · v1.0'
    )
    expect(describeCloneRevision(t, { kind: 'commit', sha: 'a'.repeat(40) })).toBe(
      `clones:revision.commit · ${'a'.repeat(40)}`
    )
    expect(describeCloneRevision(t, undefined)).toBe('clones:detail.revisionNone')
  })
})

describe('describeCloneAuth and describeCloneProxy', () => {
  it('labels the frozen auth mode', () => {
    expect(describeCloneAuth(t, 'system')).toBe('clones:detail.authSystem')
    expect(describeCloneAuth(t, 'app-token')).toBe('clones:detail.authAppToken')
    expect(describeCloneAuth(t, 'none')).toBe('clones:auth.none')
  })

  it('labels system/direct/manual proxy snapshots', () => {
    expect(describeCloneProxy(t, { mode: 'system' })).toBe('clones:proxy.system')
    expect(describeCloneProxy(t, { mode: 'direct' })).toBe('clones:proxy.direct')
    expect(describeCloneProxy(t, { mode: 'manual', url: 'http://127.0.0.1:7897' })).toBe(
      'clones:detail.proxyManual'
    )
  })
})

describe('describeClonePhase', () => {
  it('resolves known phases to their locale key and passes unknown strings through', () => {
    expect(describeClonePhase(t, 'receiving')).toBe('clones:phase.receiving')
    expect(describeClonePhase(t, 'xet')).toBe('clones:phase.xet')
    expect(describeClonePhase(t, 'mystery' as never)).toBe('mystery')
  })
})

describe('redactCloneText', () => {
  it('masks credential-bearing URLs, bearer headers, hf_ tokens, and query secrets', () => {
    const leaked = [
      'clone https://user:hf_AbCdEf123456@huggingface.co/acme/x failed',
      'Authorization: Bearer sk-abcdefgh123456',
      'token hf_LmNoPqRs90123456 in log',
      'resolve?access_token=hf_Secret&next=1'
    ].join('\n')
    const redacted = redactCloneText(leaked)
    expect(redacted).not.toContain('hf_AbCdEf123456')
    expect(redacted).not.toContain('hf_LmNoPqRs90123456')
    expect(redacted).not.toContain('sk-abcdefgh123456')
    expect(redacted).not.toContain('hf_Secret')
    expect(redacted).not.toContain('https://user:')
    expect(redacted).toContain('<redacted>')
  })

  it('leaves clean text untouched', () => {
    expect(redactCloneText('queued at 2026-08-17')).toBe('queued at 2026-08-17')
  })
})

describe('serializeCloneDetails', () => {
  it('produces a clipboard-safe sanitized summary with fixed detail lines', () => {
    const record = clone({
      id: '44444444-4444-4444-8444-444444444444',
      status: 'failed',
      error: 'auth failed for https://user:hf_AbCdEf123456@huggingface.co/acme/x'
    })
    const text = serializeCloneDetails(t, record, 'en')
    expect(text).toContain('clones:detail.repository')
    expect(text).toContain('clones:detail.destination')
    expect(text).not.toContain('hf_AbCdEf123456')
    expect(text).not.toContain('https://user:')
    expect(text).toContain('<redacted>')
  })
})
