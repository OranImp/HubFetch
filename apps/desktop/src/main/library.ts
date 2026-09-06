/** Local library: favorites, browse history, and the follow/inbox tables. */
import { randomUUID } from 'node:crypto'
import type {
  FavoriteItem,
  Follow,
  FollowTargetType,
  HistoryItem,
  HistoryLimit,
  InboxItem,
  RepoKind,
  RepoSummary
} from '@hubfetch/shared'
import type { AppDatabase } from './db'
import { LEGACY_LOCAL_ORIGIN } from './db'

const DEFAULT_HISTORY_LIMIT: HistoryLimit = 200

export class Library {
  constructor(
    private readonly db: AppDatabase,
    private readonly getHistoryLimit: () => number = () => DEFAULT_HISTORY_LIMIT,
    private readonly getAccountId: () => string | null = () => null
  ) {}

  private accountScope(accountId = this.getAccountId()): string | null {
    return accountId
  }

  private legacyScopeWhere(accountId: string | null): { sql: string; value?: string } {
    return accountId === null
      ? { sql: 'account_id IS NULL AND legacy_origin = ?', value: LEGACY_LOCAL_ORIGIN }
      : { sql: 'account_id = ?', value: accountId }
  }

  listFavorites(): FavoriteItem[] {
    const rows = this.db.prepare('SELECT * FROM favorites ORDER BY added_at DESC').all() as Array<{
      repo_id: string
      kind: string
      added_at: string
      summary_json: string
    }>
    return rows.map((r) => ({
      repoId: r.repo_id,
      kind: r.kind as RepoKind,
      addedAt: r.added_at,
      summary: JSON.parse(r.summary_json) as RepoSummary
    }))
  }

  addFavorite(summary: RepoSummary): FavoriteItem[] {
    this.db
      .prepare(
        `INSERT INTO favorites (repo_id, kind, added_at, summary_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, kind) DO UPDATE SET summary_json = excluded.summary_json`
      )
      .run(summary.id, summary.kind, new Date().toISOString(), JSON.stringify(summary))
    return this.listFavorites()
  }

  removeFavorite(kind: RepoKind, repoId: string): FavoriteItem[] {
    this.db.prepare('DELETE FROM favorites WHERE repo_id = ? AND kind = ?').run(repoId, kind)
    return this.listFavorites()
  }

  listHistory(): HistoryItem[] {
    const limit = this.getHistoryLimit()
    const rows = this.db
      .prepare('SELECT * FROM history ORDER BY viewed_at DESC LIMIT ?')
      .all(limit) as Array<{
      repo_id: string
      kind: string
      viewed_at: string
      summary_json: string
    }>
    return rows.map((r) => ({
      repoId: r.repo_id,
      kind: r.kind as RepoKind,
      viewedAt: r.viewed_at,
      summary: JSON.parse(r.summary_json) as RepoSummary
    }))
  }

  recordHistory(summary: RepoSummary): void {
    this.db
      .prepare(
        `INSERT INTO history (repo_id, kind, viewed_at, summary_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, kind) DO UPDATE SET
           viewed_at = excluded.viewed_at, summary_json = excluded.summary_json`
      )
      .run(summary.id, summary.kind, new Date().toISOString(), JSON.stringify(summary))
    this.pruneHistory(this.getHistoryLimit())
  }

  private pruneHistory(limit: number): void {
    this.db
      .prepare(
        `DELETE FROM history WHERE rowid NOT IN (
           SELECT rowid FROM history ORDER BY viewed_at DESC LIMIT ?
         )`
      )
      .run(limit)
  }

  clearHistory(): void {
    this.db.prepare('DELETE FROM history').run()
  }

  listFollows(accountId = this.accountScope()): Follow[] {
    const scope = this.legacyScopeWhere(accountId)
    const rows = this.db
      .prepare(`SELECT * FROM follows WHERE ${scope.sql} ORDER BY created_at`)
      .all(...(scope.value === undefined ? [] : [scope.value])) as Array<{
      id: string
      account_id: string | null
      legacy_origin: string | null
      type: string
      target: string
      created_at: string
      last_checked_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      type: r.type as FollowTargetType,
      target: r.target,
      createdAt: r.created_at,
      lastCheckedAt: r.last_checked_at ?? undefined,
      ...(r.account_id === null ? {} : { accountId: r.account_id }),
      ...(r.legacy_origin === null
        ? {}
        : { legacyOrigin: r.legacy_origin as Follow['legacyOrigin'] })
    }))
  }

  addFollow(type: FollowTargetType, target: string, accountId = this.accountScope()): Follow[] {
    const existing = this.listFollows(accountId).find(
      (follow) => follow.type === type && follow.target === target
    )
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO follows (id, account_id, legacy_origin, type, target, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          accountId,
          accountId === null ? LEGACY_LOCAL_ORIGIN : null,
          type,
          target,
          new Date().toISOString()
        )
    }
    return this.listFollows(accountId)
  }

  removeFollow(id: string, accountId = this.accountScope()): Follow[] {
    const scope = this.legacyScopeWhere(accountId)
    this.db
      .prepare(`DELETE FROM follows WHERE id = ? AND ${scope.sql}`)
      .run(id, ...(scope.value === undefined ? [] : [scope.value]))
    return this.listFollows(accountId)
  }

  getFollowState(id: string, accountId = this.accountScope()): Record<string, unknown> {
    const scope = this.legacyScopeWhere(accountId)
    const row = this.db
      .prepare(`SELECT state_json FROM follows WHERE id = ? AND ${scope.sql}`)
      .get(id, ...(scope.value === undefined ? [] : [scope.value])) as
      { state_json: string | null } | undefined
    if (!row?.state_json) return {}
    try {
      return JSON.parse(row.state_json) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  setFollowState(
    id: string,
    state: Record<string, unknown>,
    checkedAt: string,
    accountId = this.accountScope()
  ): void {
    const scope = this.legacyScopeWhere(accountId)
    this.db
      .prepare(
        `UPDATE follows SET state_json = ?, last_checked_at = ? WHERE id = ? AND ${scope.sql}`
      )
      .run(
        JSON.stringify(state),
        checkedAt,
        id,
        ...(scope.value === undefined ? [] : [scope.value])
      )
  }

  listInbox(accountId = this.accountScope()): InboxItem[] {
    const scope = this.legacyScopeWhere(accountId)
    const rows = this.db
      .prepare(`SELECT * FROM inbox WHERE ${scope.sql} ORDER BY created_at DESC LIMIT 500`)
      .all(...(scope.value === undefined ? [] : [scope.value])) as Array<{
      id: string
      account_id: string | null
      legacy_origin: string | null
      kind: string
      title: string
      body: string
      route: string
      created_at: string
      read_at: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as InboxItem['kind'],
      title: r.title,
      body: r.body,
      route: r.route,
      createdAt: r.created_at,
      readAt: r.read_at ?? undefined,
      ...(r.account_id === null ? {} : { accountId: r.account_id }),
      ...(r.legacy_origin === null
        ? {}
        : { legacyOrigin: r.legacy_origin as InboxItem['legacyOrigin'] })
    }))
  }

  addInboxItem(
    item: Omit<InboxItem, 'id' | 'createdAt'> & { dedupeKey: string },
    accountId = this.accountScope()
  ): boolean {
    const scope = accountId ?? LEGACY_LOCAL_ORIGIN
    const id = `inbox:${scope}:${item.dedupeKey}`
    const result = this.db
      .prepare(
        `INSERT INTO inbox (id, account_id, legacy_origin, kind, title, body, route, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        id,
        accountId,
        accountId === null ? LEGACY_LOCAL_ORIGIN : null,
        item.kind,
        item.title,
        item.body,
        item.route,
        new Date().toISOString()
      )
    return result.changes > 0
  }

  markInboxRead(ids: string[], accountId = this.accountScope()): InboxItem[] {
    const scope = this.legacyScopeWhere(accountId)
    const stmt = this.db.prepare(`UPDATE inbox SET read_at = ? WHERE id = ? AND ${scope.sql}`)
    const now = new Date().toISOString()
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) {
        stmt.run(now, id, ...(scope.value === undefined ? [] : [scope.value]))
      }
    })
    tx(ids)
    return this.listInbox(accountId)
  }

  clearInbox(accountId = this.accountScope()): InboxItem[] {
    const scope = this.legacyScopeWhere(accountId)
    this.db
      .prepare(`DELETE FROM inbox WHERE ${scope.sql}`)
      .run(...(scope.value === undefined ? [] : [scope.value]))
    return this.listInbox(accountId)
  }
}
