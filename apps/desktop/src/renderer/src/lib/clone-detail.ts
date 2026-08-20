/**
 * Pure display helpers for the clone queue and recovery views (plan Todo 35).
 *
 * Everything here is derived from schema-sanitized `CloneRecord` fields only:
 * the persisted record can never hold a token, pipe name, credential URL, or
 * raw stderr (the Todo 31 store schema gates those). The copy path still runs
 * a defensive redaction pass so clipboard output can never echo a leaked
 * credential even if a future record field regresses.
 */
import type { TFunction } from 'i18next'
import {
  CLONE_PROGRESS_PHASES,
  type CloneAuthMode,
  type CloneProgressPhase,
  type CloneProxySnapshot,
  type CloneRecord,
  type CloneRevision,
  type CloneStatus
} from '@hubfetch/shared'

/** Non-terminal statuses that occupy the single-active FIFO line. */
const LINE_STATUSES: readonly CloneStatus[] = ['queued', 'running', 'cancelling']

/**
 * Terminal queue records may be removed (and never cancelled). Cards and the
 * detail drawer MUST share this predicate so the remove action cannot appear
 * on queued/running/cancelling rows.
 */
export function isTerminalCloneStatus(status: CloneStatus): boolean {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return true
    case 'queued':
    case 'running':
    case 'cancelling':
      return false
  }
}

/** Deterministic FIFO comparator (created_at, id) used by the manager's list. */
export function compareCloneFifo(a: CloneRecord, b: CloneRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** 1-based queue position of one attempt within the non-terminal FIFO line. */
export function cloneQueuePosition(records: readonly CloneRecord[], id: string): number | null {
  const line = records
    .filter((record) => LINE_STATUSES.includes(record.status))
    .sort(compareCloneFifo)
  const index = line.findIndex((record) => record.id === id)
  return index === -1 ? null : index + 1
}

/** The terminal attempt a retry links back to, when it exists in the list. */
export function findRetryParent(
  records: readonly CloneRecord[],
  child: CloneRecord
): CloneRecord | null {
  if (!child.retryOf) return null
  return records.find((record) => record.id === child.retryOf) ?? null
}

/** Localized one-line revision description. */
export function describeCloneRevision(t: TFunction, revision: CloneRevision | undefined): string {
  if (!revision) return t('clones:detail.revisionNone')
  if (revision.kind === 'branch') return `${t('clones:revision.branch')} · ${revision.name}`
  if (revision.kind === 'tag') return `${t('clones:revision.tag')} · ${revision.name}`
  return `${t('clones:revision.commit')} · ${revision.sha}`
}

/** Localized authentication label for the frozen attempt. */
export function describeCloneAuth(t: TFunction, auth: CloneAuthMode): string {
  if (auth === 'app-token') return t('clones:detail.authAppToken')
  if (auth === 'none') return t('clones:auth.none')
  return t('clones:detail.authSystem')
}

/** Localized proxy label for the frozen per-attempt snapshot. */
export function describeCloneProxy(t: TFunction, snapshot: CloneProxySnapshot): string {
  if (snapshot.mode === 'manual' && snapshot.url !== null) {
    return t('clones:detail.proxyManual', { url: snapshot.url })
  }
  return t(`clones:proxy.${snapshot.mode}`)
}

/** Localized progress phase label. */
export function describeClonePhase(t: TFunction, phase: CloneProgressPhase): string {
  return CLONE_PROGRESS_PHASES.includes(phase) ? t(`clones:phase.${phase}`) : phase
}

/** Medium date + short time, in the active UI locale. */
export function formatCloneTimestamp(iso: string | undefined, locale: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

/** One labeled row in the detail drawer; also the unit of the copy payload. */
export interface CloneDetailLine {
  label: string
  value: string
}

/**
 * Fixed, whitelisted detail lines. Only persisted schema-sanitized fields are
 * read — a future field that leaks a secret would not be picked up here unless
 * deliberately added, and the copy path redacts defensively on top.
 */
export function cloneDetailLines(
  t: TFunction,
  record: CloneRecord,
  locale: string
): CloneDetailLine[] {
  const lines: CloneDetailLine[] = [
    { label: t('clones:detail.repository'), value: `${record.repoKind} · ${record.repoId}` },
    {
      label: t('clones:detail.revision'),
      value: describeCloneRevision(t, record.revision)
    },
    { label: t('clones:detail.transport'), value: t(`clones:transport.${record.transport}`) },
    { label: t('clones:detail.destination'), value: record.destination },
    { label: t('clones:detail.proxy'), value: describeCloneProxy(t, record.proxy) },
    { label: t('clones:detail.auth'), value: describeCloneAuth(t, record.auth) },
    { label: t('clones:status.' + record.status), value: t(`clones:statusHint.${record.status}`) },
    {
      label: t('clones:attempt', { n: record.attempt }),
      value: record.retryOf
        ? t('clones:detail.retryOfAttempt', { id: Math.max(1, record.attempt - 1) })
        : t('clones:detail.firstAttempt')
    }
  ]
  if (record.progress) {
    lines.push({
      label: t('clones:detail.progress'),
      value: `${describeClonePhase(t, record.progress.phase)} · ${t('clones:progress.percent', {
        percent: record.progress.percent
      })} · ${t('clones:progress.counters', {
        done: record.progress.done,
        total: record.progress.total
      })}`
    })
  }
  lines.push({
    label: t('clones:detail.created'),
    value: formatCloneTimestamp(record.createdAt, locale)
  })
  if (record.startedAt) {
    lines.push({
      label: t('clones:detail.started'),
      value: formatCloneTimestamp(record.startedAt, locale)
    })
  }
  if (record.completedAt) {
    lines.push({
      label: t('clones:detail.completed'),
      value: formatCloneTimestamp(record.completedAt, locale)
    })
  }
  if (record.error) {
    lines.push({ label: t('clones:detail.error'), value: record.error })
  }
  return lines
}

/**
 * Defensive redaction for anything about to leave the renderer (clipboard).
 * The record is already sanitized at the source; this is the last line of
 * defense against a future regression — token shapes, bearer headers, and
 * credential-bearing URLs are masked before the text is copied.
 */
export function redactCloneText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1<redacted>@')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bhf_[A-Za-z0-9]{8,}\b/g, 'hf_<redacted>')
    .replace(
      /([?&](?:token|access_?token|auth|key|password|secret|session)=)[^&#\s]+/gi,
      '$1<redacted>'
    )
    .trim()
}

/** Clipboard-safe, fully sanitized text summary of one attempt. */
export function serializeCloneDetails(t: TFunction, record: CloneRecord, locale: string): string {
  const text = cloneDetailLines(t, record, locale)
    .map((line) => `${line.label}: ${line.value}`)
    .join('\n')
  return redactCloneText(text)
}
