// apps/desktop/src/utility/clone-protocol.ts
//
// Todo 27: the shared, typed contract between the main-process CloneHost and
// the assign-before-start utility-process clone worker.
//
//   Main -> Worker (CloneCommand): arm / start / cancel
//   Worker -> Main (CloneEvent):   ready / armed / refused / started /
//                                  progress / log / terminal / cancel-ack
//
// The start envelope is IMMUTABLE: the host freezes the envelope and sends its
// SHA-256 canonical hash with the `arm` command; the worker verifies the hash
// before arming, so a missing / early / tampered envelope can never trigger a
// Git spawn. The worker is idle until armed and spawns Git ONLY after a valid
// `start` for the same assignmentId.
//
// This module is deliberately Electron-free so both the utility process and the
// main process (and vitest under plain Node) can import it.
import { createHash } from 'node:crypto'

export const CLONE_ENVELOPE_VERSION = 1 as const

/** Frozen, immutable Git start instruction set. Never carries credentials. */
export interface CloneEnvelope {
  version: typeof CLONE_ENVELOPE_VERSION
  /** Unique clone attempt id; the worker only honors messages for this id. */
  assignmentId: string
  /** Git executable (path or command name). */
  git: string
  /** argv AFTER the executable (e.g. ['clone', '--progress', url, dest]). */
  argv: string[]
  /** Working directory for the Git child. */
  cwd: string
  /** Frozen, sanitized env additions for the Git child (no secrets). */
  env: Record<string, string>
}

/** Main -> worker commands. */
export type CloneCommand =
  | { type: 'arm'; assignmentId: string; envelope: CloneEnvelope; envelopeHash: string }
  | { type: 'start'; assignmentId: string }
  | { type: 'cancel'; assignmentId: string; reason: 'user' | 'shutdown' }

/** Why the worker refused to proceed. */
export type CloneRefusalCode =
  'missing-envelope' | 'early-start' | 'tampered-envelope' | 'unknown-assignment'

/** Worker -> main events. */
export type CloneEvent =
  | { type: 'ready'; pid: number }
  | { type: 'armed'; assignmentId: string }
  | {
      type: 'refused'
      assignmentId: string | null
      code: CloneRefusalCode
      message: string
    }
  | { type: 'started'; assignmentId: string; gitPid: number }
  | { type: 'progress'; assignmentId: string; phase: string; percent: number; detail?: string }
  | { type: 'log'; assignmentId: string; line: string }
  | {
      type: 'terminal'
      assignmentId: string
      outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted'
      exitCode: number | null
      signal: string | null
    }
  | { type: 'cancel-ack'; assignmentId: string }

/** Deterministic canonical JSON: object keys sorted, no whitespace. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`).join(',')}}`
}

/** SHA-256 of the canonical envelope — the immutability anchor. */
export function hashEnvelope(envelope: CloneEnvelope): string {
  return createHash('sha256').update(canonicalStringify(envelope)).digest('hex')
}

export function isCloneEnvelope(value: unknown): value is CloneEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.version === CLONE_ENVELOPE_VERSION &&
    typeof v.assignmentId === 'string' &&
    v.assignmentId.length > 0 &&
    typeof v.git === 'string' &&
    v.git.length > 0 &&
    Array.isArray(v.argv) &&
    v.argv.every((a) => typeof a === 'string') &&
    typeof v.cwd === 'string' &&
    typeof v.env === 'object' &&
    v.env !== null
  )
}
