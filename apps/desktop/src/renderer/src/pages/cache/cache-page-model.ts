import type {
  AuthState,
  CacheActionKind,
  CacheApplyFailureReason,
  CacheVerificationEntry,
  CacheVerificationIssue,
  CacheVerificationProgress,
  CacheVerificationReport,
  CacheVerificationRepo
} from '@hubfetch/shared'

export const REPAIRABLE_ISSUES = [
  'hash-mismatch',
  'broken-snapshot-link',
  'unmatched-snapshot-copy'
] as const satisfies readonly CacheVerificationIssue[]

export type RepairableIssue = (typeof REPAIRABLE_ISSUES)[number]

export type RepairBlockReason = 'signed-out' | 'account-unavailable' | 'unsupported' | 'no-issues'

export type IssueBucket = 'verified' | 'corrupt' | 'unreadable'

export interface VerificationCounts {
  readonly verified: number
  readonly corrupt: number
  readonly unreadable: number
}

const STALE_PLAN_REASONS = [
  'plan-not-found',
  'plan-expired',
  'plan-digest-mismatch',
  'plan-stale-filesystem',
  'plan-stale-protected',
  'plan-stale-account',
  'plan-stale-environment'
] as const satisfies readonly CacheApplyFailureReason[]

function assertNever(value: never): never {
  throw new Error(`unexpected cache page variant: ${String(value)}`)
}

export function isRepairableIssue(issue: CacheVerificationIssue): issue is RepairableIssue {
  return REPAIRABLE_ISSUES.some((candidate) => candidate === issue)
}

export function bucketOf(issue: CacheVerificationIssue): Exclude<IssueBucket, 'verified'> {
  return issue === 'unreadable' ? 'unreadable' : 'corrupt'
}

export function countsOf(report: CacheVerificationReport): VerificationCounts {
  let corrupt = 0
  let unreadable = 0
  for (const repo of report.repos) {
    for (const entry of repo.issues) {
      if (bucketOf(entry.issue) === 'unreadable') unreadable += 1
      else corrupt += 1
    }
  }
  return { verified: report.totalVerifiedBlobs, corrupt, unreadable }
}

export function repairableEntriesOf(
  issues: readonly CacheVerificationEntry[]
): readonly CacheVerificationEntry[] {
  return issues.filter((entry) => isRepairableIssue(entry.issue))
}

export function repairBlockReason(
  auth: AuthState,
  issues: readonly CacheVerificationEntry[] | undefined
): RepairBlockReason | null {
  switch (auth.status) {
    case 'signedOut':
      return 'signed-out'
    case 'credential-corrupt':
      return 'account-unavailable'
    case 'signedIn':
      break
    default:
      return assertNever(auth)
  }
  if (issues === undefined) return 'no-issues'
  if (issues.length === 0) return 'no-issues'
  if (repairableEntriesOf(issues).length === 0) return 'unsupported'
  return null
}

export function isStalePlanReason(reason: CacheApplyFailureReason): boolean {
  return STALE_PLAN_REASONS.some((candidate) => candidate === reason)
}

export function isVerifyAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'CacheVerifyAbortedError' || error.message === 'aborted'
}

export function verificationProgressValue(progress: CacheVerificationProgress): number | undefined {
  switch (progress.phase) {
    case 'scanning':
      return undefined
    case 'verifying':
      return progress.totalRepos === 0 ? 1 : progress.completedRepos / progress.totalRepos
    case 'done':
      return 1
    default:
      return assertNever(progress.phase)
  }
}

export function repoVerificationOf(
  report: CacheVerificationReport | null,
  kind: CacheVerificationRepo['kind'],
  repoId: string
): CacheVerificationRepo | undefined {
  return report?.repos.find((repo) => repo.kind === kind && repo.id === repoId)
}

export function applySuccessKey(action: CacheActionKind): 'apply.pruneSuccess' | 'apply.repairSuccess' {
  switch (action) {
    case 'prune':
      return 'apply.pruneSuccess'
    case 'repair':
      return 'apply.repairSuccess'
    default:
      return assertNever(action)
  }
}

export function repairHintKey(
  reason: RepairBlockReason | null
):
  | 'repairTooltip'
  | 'repairDisabled.signedOut'
  | 'repairDisabled.accountUnavailable'
  | 'repairDisabled.unsupported'
  | 'repairDisabled.noIssues' {
  switch (reason) {
    case null:
      return 'repairTooltip'
    case 'signed-out':
      return 'repairDisabled.signedOut'
    case 'account-unavailable':
      return 'repairDisabled.accountUnavailable'
    case 'unsupported':
      return 'repairDisabled.unsupported'
    case 'no-issues':
      return 'repairDisabled.noIssues'
    default:
      return assertNever(reason)
  }
}
