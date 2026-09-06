/**
 * Clone attempt persistence records (plan Todo 31).
 *
 * One `clone_tasks` row is ONE immutable attempt of a clone. A retry never
 * mutates a terminal row — it inserts a NEW linked row (`retryOf`, `attempt+1`)
 * whose destination must be absent or empty. Statuses form a closed exhaustive
 * union driven by a strict transition matrix (see the desktop `CloneStore`);
 * terminal rows are immutable. The schema only ever holds sanitized, validated
 * values: a token, pipe name, credential URL, or raw stderr can never satisfy a
 * column.
 */
import { z } from 'zod'
import {
  cloneAuthModeSchema,
  cloneDestinationSchema,
  cloneNamespaceNameSchema,
  cloneRepoKindSchema,
  cloneRequestSchema,
  cloneRevisionSchema,
  cloneTransportSchema,
  type CloneAuthMode,
  type CloneRepoKind,
  type CloneRevision,
  type CloneTransport
} from './clone'
import { downloadProxyOverride } from './schemas'
import type { ProxySnapshot } from './types'

export type { CloneAuthMode, CloneRepoKind, CloneRevision, CloneTransport }
export type { ProxySnapshot }

/** Closed clone attempt statuses. Terminal states are immutable. */
export const CLONE_STATUSES = [
  'queued',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const
export type CloneStatus = (typeof CLONE_STATUSES)[number]

/** Typed clone failure codes (Todo 29 contract), persisted with sanitized detail. */
export const CLONE_ERROR_CODES = [
  'dependency',
  'auth',
  'account-unavailable',
  'gated',
  'not-found',
  'network',
  'proxy',
  'disk',
  'destination',
  'cancelled',
  'internal'
] as const
export type CloneErrorCode = (typeof CLONE_ERROR_CODES)[number]

/** Closed set of documented clone progress phases (Git + Git-Xet). */
export const CLONE_PROGRESS_PHASES = [
  'enumerating',
  'counting',
  'compressing',
  'receiving',
  'resolving',
  'updating',
  'checkout',
  'xet'
] as const
export type CloneProgressPhase = (typeof CLONE_PROGRESS_PHASES)[number]

/** Frozen progress state persisted per attempt; percent 0..100, done <= total. */
export const cloneProgressSchema = z
  .object({
    phase: z.enum(CLONE_PROGRESS_PHASES),
    percent: z.number().int().min(0).max(100),
    done: z.number().int().min(0),
    total: z.number().int().min(0)
  })
  .strict()
export type CloneProgress = z.infer<typeof cloneProgressSchema>

/**
 * Frozen per-attempt proxy snapshot (Todo 19). Structurally identical to the
 * closed per-create override — the snapshot is the resolved value persisted.
 */
export const cloneProxySnapshotSchema = downloadProxyOverride
export type CloneProxySnapshot = z.infer<typeof cloneProxySnapshotSchema>

/**
 * Input for persisting ONE clone attempt: the Todo 29 request plus the frozen
 * proxy snapshot resolved at creation. `proxy` is required here because the
 * snapshot — never the live settings — is what gets persisted. `.strict()`
 * rejects unknown fields, and the id/revision/destination schemas already
 * reject option injection, credentials, and raw URLs.
 */
export const cloneCreateInputSchema = cloneRequestSchema
  .extend({
    proxy: downloadProxyOverride,
    accountId: z.uuid().optional(),
    accountLabel: z.string().max(256).optional()
  })
  .superRefine((input, context) => {
    if (input.auth === 'app-token' && input.accountId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['accountId'],
        message: 'app-token clones require an account'
      })
    }
  })
  .strict()
export type CloneCreateInput = z.infer<typeof cloneCreateInputSchema>

/**
 * Persisted failure input: a closed typed code plus a bounded, sanitized
 * string. Anything outside these bounds (a raw stderr dump, a token, an
 * untyped message) is rejected before it can be written.
 */
export const cloneFailureInputSchema = z
  .object({
    errorCode: z.enum(CLONE_ERROR_CODES).optional(),
    error: z.string().max(2000).optional()
  })
  .strict()
export type CloneFailureInput = z.infer<typeof cloneFailureInputSchema>

/**
 * One persisted clone attempt as returned by the store. `revision` is the
 * structured closed union (branch/tag/commit), `proxy` the frozen snapshot,
 * `error` the sanitized bounded failure detail, `progress` the last recorded
 * phase/percent/counters, and `retryOf` links a retry to the terminal parent.
 */
export const cloneRecordSchema = z
  .object({
    id: z.string().uuid(),
    attempt: z.number().int().min(1),
    repoKind: cloneRepoKindSchema,
    repoId: cloneNamespaceNameSchema,
    revision: cloneRevisionSchema.optional(),
    transport: cloneTransportSchema,
    destination: cloneDestinationSchema,
    auth: cloneAuthModeSchema,
    accountId: z.uuid().optional(),
    accountLabel: z.string().max(256).optional(),
    proxy: cloneProxySnapshotSchema,
    status: z.enum(CLONE_STATUSES),
    progress: cloneProgressSchema.optional(),
    error: z.string().max(2000).optional(),
    createdAt: z.string().min(1).max(64),
    startedAt: z.string().min(1).max(64).optional(),
    updatedAt: z.string().min(1).max(64),
    completedAt: z.string().min(1).max(64).optional(),
    retryOf: z.string().uuid().optional()
  })
  .strict()
export type CloneRecord = z.infer<typeof cloneRecordSchema>
