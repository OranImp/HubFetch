import Database from 'better-sqlite3'
import { DEFAULT_MANUAL_PROXY_URL, normalizeManualProxyUrl } from '@hubfetch/shared'
import { databaseFile } from './runtime-paths'

export type AppDatabase = Database.Database

/**
 * All local state lives in one SQLite file under userData:
 * favorites, history, download tasks, follows, inbox, settings, and the
 * app metadata. Access tokens use the separate safeStorage-encrypted credentials
 * file; the auth table remains only for one-way migration from older releases.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE favorites (
    repo_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    added_at TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    PRIMARY KEY (repo_id, kind)
  );
  CREATE TABLE history (
    repo_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    viewed_at TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    PRIMARY KEY (repo_id, kind)
  );
  CREATE TABLE downloads (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    revision TEXT NOT NULL,
    status TEXT NOT NULL,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    files_json TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE follows (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_checked_at TEXT,
    state_json TEXT,
    UNIQUE (type, target)
  );
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    route TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE TABLE auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token_cipher BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_inbox_created ON inbox (created_at DESC);
  `,
  `
  ALTER TABLE downloads ADD COLUMN resolved_commit TEXT;
  ALTER TABLE downloads ADD COLUMN endpoint TEXT;
  ALTER TABLE downloads ADD COLUMN proxy_url TEXT;
  ALTER TABLE downloads ADD COLUMN cache_dir TEXT;
  ALTER TABLE downloads ADD COLUMN environment_version INTEGER;
  ALTER TABLE downloads ADD COLUMN error_code TEXT;

  -- Pre-environment downloads cannot be resumed safely: their endpoint,
  -- proxy, and cache root are unknowable. Terminal rows remain visible.
  UPDATE downloads
     SET status = 'error',
         error_code = 'legacy-task',
         error = 'This download was created by an older version and cannot be resumed.'
   WHERE status IN ('queued', 'running', 'paused', 'error');
  `,
  `
  ALTER TABLE downloads ADD COLUMN proxy_mode TEXT;

  -- Map pre-existing rows to the closed proxy modes: a stored URL was a manual
  -- override, a null URL meant "no override" (system route). Direct mode never
  -- existed before, so nothing maps to it. The stored settings JSON (kv
  -- 'settings' row) is upgraded in JS by upgradeStoredSettingsProxy, which runs
  -- alongside this migration.
  UPDATE downloads
     SET proxy_mode = CASE WHEN proxy_url IS NULL THEN 'system' ELSE 'manual' END
   WHERE proxy_mode IS NULL;
  `
]

/**
 * Upgrade the stored settings JSON from the legacy nullable `proxyUrl` field to
 * the closed `proxy` config. A legacy non-null URL that survives strict
 * validation maps to Manual mode (preserving the user's choice); anything
 * credential-bearing or malformed falls back to System + the seeded Manual URL.
 * Corrupt JSON is left alone (SettingsStore already falls back to defaults).
 * Idempotent: a settings row that already carries `proxy` only drops `proxyUrl`.
 */
function upgradeStoredSettingsProxy(db: AppDatabase): void {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('settings') as
    { value: string } | undefined
  if (!row) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(row.value) as Record<string, unknown>
  } catch {
    return
  }
  if ('proxy' in parsed) {
    delete parsed.proxyUrl
    db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(parsed), 'settings')
    return
  }
  const legacyUrl =
    typeof parsed.proxyUrl === 'string' && parsed.proxyUrl.trim() ? parsed.proxyUrl : null
  delete parsed.proxyUrl
  const carried = legacyUrl ? normalizeManualProxyUrl(legacyUrl) : null
  parsed.proxy = carried
    ? { mode: 'manual', manualUrl: carried }
    : { mode: 'system', manualUrl: DEFAULT_MANUAL_PROXY_URL }
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('settings', JSON.stringify(parsed))
}

export function openDatabase(filePath?: string): AppDatabase {
  const file = filePath ?? databaseFile()
  const db: AppDatabase = new Database(file)
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

export function migrate(db: AppDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]
    if (!sql) continue
    db.transaction(() => {
      db.exec(sql)
      // The settings JSON lives in the kv table, not in SQL columns, so its
      // proxy upgrade runs as part of the final migration transaction.
      if (v === MIGRATIONS.length - 1) upgradeStoredSettingsProxy(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
