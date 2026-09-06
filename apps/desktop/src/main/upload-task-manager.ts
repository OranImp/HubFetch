/**
 * UploadTaskManager — append-only DB persistence for upload tasks (plan Todo 18).
 *
 * Every upload task is written to the `upload_tasks` table at creation and
 * updated through its lifecycle. On startup, active rows (preparing/running)
 * are converted to `interrupted` without any network activity. Retry obtains
 * the original account by ID, rescans the root, rehashes all selected files,
 * and requires an identical manifest fingerprint and warning acknowledgments.
 *
 * NEVER persisted: token, file content, ignored sensitive path samples,
 * device/inode as restart identity, or open handles.
 */
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { AppDatabase } from './db'
import type {
  RepoKind,
  UploadTaskRecord,
  UploadWarningCode,
  IntegrationTaskStatus
} from '@hubfetch/shared'

const HASH_CHUNK_SIZE = 256 * 1024

export interface UploadTaskInsert {
  id: string
  accountId: string | null
  accountLabel: string | null
  repoKind: RepoKind
  repoName: string
  repoVisibility: 'public' | 'private'
  rootPath: string
  manifestFingerprint: string
  warningCodes: UploadWarningCode[]
  summaryFileCount: number
  summaryTotalBytes: number
  status: IntegrationTaskStatus
  phase: string
  progress: number
  messageKey?: string
  params?: Record<string, string>
  repoId?: string
  repoUrl?: string
}

export interface FileHashResult {
  relativePath: string
  size: number
  contentSha256: string
}

/**
 * Compute SHA-256 for a single file with bounded memory (reads in 256KB chunks).
 * Returns the hex digest.
 */
export async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256')
  const handle = await open(absolutePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_SIZE)
    let bytesRead: number
    do {
      bytesRead = (await handle.read(buffer, 0, buffer.length, null)).bytesRead
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Compute deterministic manifest fingerprint: SHA-256 over sorted
 * (relativePath, size, contentSha256) tuples.
 */
export function computeManifestFingerprint(hashes: FileHashResult[]): string {
  const sorted = [...hashes].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const hash = createHash('sha256')
  for (const entry of sorted) {
    hash.update(entry.relativePath)
    hash.update('\x00')
    hash.update(String(entry.size))
    hash.update('\x00')
    hash.update(entry.contentSha256)
    hash.update('\x00')
  }
  return hash.digest('hex')
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

export class UploadTaskManager {
  constructor(private readonly db: AppDatabase) {}

  /** Insert a new upload task row. */
  insert(task: UploadTaskInsert): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO upload_tasks (
          id, account_id, account_label, repo_kind, repo_name, repo_visibility,
          root_path, manifest_fingerprint, warning_codes,
          summary_file_count, summary_total_bytes,
          status, phase, progress, message_key, params_json,
          repo_id, repo_url, created_at, updated_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )`
      )
      .run(
        task.id,
        task.accountId,
        task.accountLabel,
        task.repoKind,
        task.repoName,
        task.repoVisibility,
        task.rootPath,
        task.manifestFingerprint,
        JSON.stringify(task.warningCodes),
        task.summaryFileCount,
        task.summaryTotalBytes,
        task.status,
        task.phase,
        task.progress,
        task.messageKey ?? null,
        task.params ? JSON.stringify(task.params) : null,
        task.repoId ?? null,
        task.repoUrl ?? null,
        now,
        now,
        null
      )
  }

  /** Update fields on an existing task row. Returns false if row not found. */
  update(
    id: string,
    patch: {
      status?: IntegrationTaskStatus
      phase?: string
      progress?: number
      messageKey?: string
      params?: Record<string, string>
      repoId?: string
      repoUrl?: string
      manifestFingerprint?: string
    }
  ): boolean {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = ?']
    const values: unknown[] = [now]
    if (patch.status !== undefined) {
      sets.push('status = ?')
      values.push(patch.status)
      if (
        patch.status === 'done' ||
        patch.status === 'error' ||
        patch.status === 'canceled' ||
        patch.status === 'interrupted' ||
        patch.status === 'selection-stale' ||
        patch.status === 'account-unavailable'
      ) {
        sets.push('completed_at = ?')
        values.push(now)
      }
    }
    if (patch.phase !== undefined) {
      sets.push('phase = ?')
      values.push(patch.phase)
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?')
      values.push(patch.progress)
    }
    if (patch.messageKey !== undefined) {
      sets.push('message_key = ?')
      values.push(patch.messageKey ?? null)
    }
    if (patch.params !== undefined) {
      sets.push('params_json = ?')
      values.push(patch.params ? JSON.stringify(patch.params) : null)
    }
    if (patch.repoId !== undefined) {
      sets.push('repo_id = ?')
      values.push(patch.repoId ?? null)
    }
    if (patch.repoUrl !== undefined) {
      sets.push('repo_url = ?')
      values.push(patch.repoUrl ?? null)
    }
    if (patch.manifestFingerprint !== undefined) {
      sets.push('manifest_fingerprint = ?')
      values.push(patch.manifestFingerprint)
    }
    values.push(id)
    const result = this.db
      .prepare(`UPDATE upload_tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values)
    return result.changes > 0
  }

  /** List all persisted upload tasks, newest first. */
  list(): UploadTaskRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, account_label, repo_kind, repo_name, repo_visibility,
                root_path, manifest_fingerprint, warning_codes,
                summary_file_count, summary_total_bytes,
                status, phase, progress, message_key, params_json,
                repo_id, repo_url, created_at, updated_at, completed_at
         FROM upload_tasks
         ORDER BY created_at DESC, id DESC`
      )
      .all() as Array<{
      id: string
      account_id: string | null
      account_label: string | null
      repo_kind: string
      repo_name: string
      repo_visibility: string
      root_path: string
      manifest_fingerprint: string
      warning_codes: string
      summary_file_count: number
      summary_total_bytes: number
      status: string
      phase: string
      progress: number
      message_key: string | null
      params_json: string | null
      repo_id: string | null
      repo_url: string | null
      created_at: string
      updated_at: string
      completed_at: string | null
    }>
    return rows.map(this.rowToRecord)
  }

  /** Get a single task by id. */
  get(id: string): UploadTaskRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, account_id, account_label, repo_kind, repo_name, repo_visibility,
                root_path, manifest_fingerprint, warning_codes,
                summary_file_count, summary_total_bytes,
                status, phase, progress, message_key, params_json,
                repo_id, repo_url, created_at, updated_at, completed_at
         FROM upload_tasks WHERE id = ?`
      )
      .get(id) as
      | {
          id: string
          account_id: string | null
          account_label: string | null
          repo_kind: string
          repo_name: string
          repo_visibility: string
          root_path: string
          manifest_fingerprint: string
          warning_codes: string
          summary_file_count: number
          summary_total_bytes: number
          status: string
          phase: string
          progress: number
          message_key: string | null
          params_json: string | null
          repo_id: string | null
          repo_url: string | null
          created_at: string
          updated_at: string
          completed_at: string | null
        }
      | undefined
    if (!row) return undefined
    return this.rowToRecord(row)
  }

  /**
   * On startup: convert every preparing/running/hashing row to interrupted.
   * Never performs network activity. Returns the count of converted rows.
   */
  interruptActive(): number {
    const now = new Date().toISOString()
    const result = this.db
      .prepare(
        `UPDATE upload_tasks
            SET status = 'interrupted',
                phase = 'interrupted',
                updated_at = ?,
                completed_at = ?
          WHERE status IN ('preparing', 'running', 'hashing')`
      )
      .run(now, now)
    return result.changes
  }

  /**
   * Remove a terminal task row. Only terminal states (done, error, canceled,
   * interrupted, selection-stale, account-unavailable) can be removed.
   */
  remove(id: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM upload_tasks
          WHERE id = ?
            AND status IN ('done', 'error', 'canceled', 'interrupted', 'selection-stale', 'account-unavailable')`
      )
      .run(id)
    return result.changes > 0
  }

  private rowToRecord(row: {
    id: string
    account_id: string | null
    account_label: string | null
    repo_kind: string
    repo_name: string
    repo_visibility: string
    root_path: string
    manifest_fingerprint: string
    warning_codes: string
    summary_file_count: number
    summary_total_bytes: number
    status: string
    phase: string
    progress: number
    message_key: string | null
    params_json: string | null
    repo_id: string | null
    repo_url: string | null
    created_at: string
    updated_at: string
    completed_at: string | null
  }): UploadTaskRecord {
    let params: Record<string, string> | undefined
    if (row.params_json) {
      try {
        params = JSON.parse(row.params_json) as Record<string, string>
      } catch {
        params = undefined
      }
    }
    return {
      id: row.id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      repoKind: row.repo_kind as RepoKind,
      repoName: row.repo_name,
      repoVisibility: row.repo_visibility as 'public' | 'private',
      rootPath: row.root_path,
      manifestFingerprint: row.manifest_fingerprint,
      warningCodes: JSON.parse(row.warning_codes) as UploadWarningCode[],
      summaryFileCount: row.summary_file_count,
      summaryTotalBytes: row.summary_total_bytes,
      status: row.status as IntegrationTaskStatus,
      phase: row.phase,
      progress: row.progress,
      messageKey: row.message_key ?? undefined,
      params,
      repoId: row.repo_id ?? undefined,
      repoUrl: row.repo_url ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined
    }
  }
}