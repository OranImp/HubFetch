import { describe, expect, it } from 'vitest'
import type {
  AuthState,
  CacheApplyFailureReason,
  CacheVerificationEntry,
  CacheVerificationProgress,
  CacheVerificationReport
} from '@hubfetch/shared'
import {
  applySuccessKey,
  bucketOf,
  countsOf,
  isStalePlanReason,
  isVerifyAbort,
  repairBlockReason,
  repairableEntriesOf,
  verificationProgressValue
} from './cache-page-model'

const SIGNED_OUT: AuthState = { status: 'signedOut' }
const CORRUPT: AuthState = { status: 'credential-corrupt', backupFile: 'credentials.bak' }
const SIGNED_IN: AuthState = {
  status: 'signedIn',
  accountId: 'acct-1',
  user: { name: 'ada', orgs: [] },
  method: 'token'
}

function entry(issue: CacheVerificationEntry['issue'], path: string): CacheVerificationEntry {
  return { issue, path }
}

function report(issues: readonly CacheVerificationEntry[]): CacheVerificationReport {
  return {
    root: '/cache',
    ok: issues.length === 0,
    repos: [
      {
        id: 'org/name',
        kind: 'model',
        ok: issues.length === 0,
        verifiedBlobs: 4,
        verifiedBytes: 40,
        issues: [...issues],
        partialFiles: 0,
        partialBytes: 0
      }
    ],
    totalVerifiedBlobs: 4,
    totalVerifiedBytes: 40,
    totalIssues: issues.length,
    totalPartialFiles: 0,
    totalPartialBytes: 0,
    truncated: false,
    scannedAt: '2026-09-05T00:00:00.000Z'
  }
}

describe('cache-page-model', () => {
  it('buckets unreadable separately from corrupt issues', () => {
    expect(bucketOf('unreadable')).toBe('unreadable')
    expect(bucketOf('hash-mismatch')).toBe('corrupt')
    expect(bucketOf('snapshot-escape')).toBe('corrupt')
    expect(countsOf(report([entry('hash-mismatch', 'blobs/aa'), entry('unreadable', 'blobs/bb')]))).toEqual(
      { verified: 4, corrupt: 1, unreadable: 1 }
    )
  })

  it('counts a clean report as verified with zero issues', () => {
    expect(countsOf(report([]))).toEqual({ verified: 4, corrupt: 0, unreadable: 0 })
  })

  it('keeps only repairable issue entries', () => {
    const issues = [
      entry('hash-mismatch', 'blobs/aa'),
      entry('unreadable', 'blobs/bb'),
      entry('broken-snapshot-link', 'snapshots/c/file.bin'),
      entry('invalid-blob-name', 'blobs/nope')
    ]
    expect(repairableEntriesOf(issues).map((item) => item.issue)).toEqual([
      'hash-mismatch',
      'broken-snapshot-link'
    ])
  })

  it('blocks repair when signed out, account is corrupt, or mapping is unsupported', () => {
    expect(repairBlockReason(SIGNED_OUT, [entry('hash-mismatch', 'blobs/aa')])).toBe('signed-out')
    expect(repairBlockReason(CORRUPT, [entry('hash-mismatch', 'blobs/aa')])).toBe(
      'account-unavailable'
    )
    expect(repairBlockReason(SIGNED_IN, undefined)).toBe('no-issues')
    expect(repairBlockReason(SIGNED_IN, [])).toBe('no-issues')
    expect(repairBlockReason(SIGNED_IN, [entry('unreadable', 'blobs/aa')])).toBe('unsupported')
    expect(repairBlockReason(SIGNED_IN, [entry('hash-mismatch', 'blobs/aa')])).toBeNull()
  })

  it('treats consumed/stale plan failures as requiring a replan', () => {
    const stale: CacheApplyFailureReason[] = [
      'plan-not-found',
      'plan-expired',
      'plan-digest-mismatch',
      'plan-stale-filesystem',
      'plan-stale-protected',
      'plan-stale-account',
      'plan-stale-environment'
    ]
    for (const reason of stale) expect(isStalePlanReason(reason)).toBe(true)
    expect(isStalePlanReason('network')).toBe(false)
    expect(isStalePlanReason('unsupported-issue')).toBe(false)
    expect(isStalePlanReason('account-unavailable')).toBe(false)
  })

  it('detects cooperative verification cancellation from the flattened IPC error', () => {
    expect(isVerifyAbort(new Error('aborted'))).toBe(true)
    const named = new Error('aborted')
    named.name = 'CacheVerifyAbortedError'
    expect(isVerifyAbort(named)).toBe(true)
    expect(isVerifyAbort(new Error('hash failed'))).toBe(false)
  })

  it('keeps scanning indeterminate and bounds verifying/done to 0..1', () => {
    const scanning: CacheVerificationProgress = {
      phase: 'scanning',
      completedRepos: 0,
      totalRepos: 2,
      verifiedBlobs: 0,
      issuesFound: 0
    }
    expect(verificationProgressValue(scanning)).toBeUndefined()
    expect(
      verificationProgressValue({
        phase: 'verifying',
        completedRepos: 1,
        totalRepos: 4,
        verifiedBlobs: 3,
        issuesFound: 0
      })
    ).toBe(0.25)
    expect(
      verificationProgressValue({
        phase: 'verifying',
        completedRepos: 0,
        totalRepos: 0,
        verifiedBlobs: 0,
        issuesFound: 0
      })
    ).toBe(1)
    expect(
      verificationProgressValue({
        phase: 'done',
        completedRepos: 2,
        totalRepos: 2,
        verifiedBlobs: 8,
        issuesFound: 0
      })
    ).toBe(1)
  })

  it('routes apply success copy by action', () => {
    expect(applySuccessKey('prune')).toBe('apply.pruneSuccess')
    expect(applySuccessKey('repair')).toBe('apply.repairSuccess')
  })
})
