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
  `,
  `
  -- Clone attempts (plan Todo 31): one row = ONE immutable attempt of a clone.
  -- A retry inserts a NEW linked row (attempt+1, retry_of=parent) into a fresh
  -- or empty destination; terminal rows are never mutated. Every enum column
  -- carries a CHECK so a token, pipe name, credential URL, or raw stderr can
  -- never satisfy the schema at the engine level; revision_json must be valid
  -- JSON (the store writes only serialized, schema-validated revisions). The
  -- FIFO order is (created_at, id); at most one row is active (running or
  -- cancelling) at a time.
  CREATE TABLE clone_tasks (
    id TEXT PRIMARY KEY,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    repo_kind TEXT NOT NULL CHECK (repo_kind IN ('model', 'dataset', 'space')),
    repo_id TEXT NOT NULL CHECK (length(repo_id) BETWEEN 1 AND 255),
    revision_json TEXT CHECK (revision_json IS NULL OR json_valid(revision_json)),
    transport TEXT NOT NULL CHECK (transport IN ('https', 'ssh')),
    destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 1024),
    auth TEXT NOT NULL CHECK (auth IN ('none', 'app-token', 'system')),
    proxy_mode TEXT NOT NULL CHECK (proxy_mode IN ('system', 'direct', 'manual')),
    proxy_url TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted')
    ),
    error_code TEXT CHECK (
      error_code IS NULL OR
      error_code IN ('dependency', 'auth', 'gated', 'not-found', 'network', 'proxy', 'disk', 'destination', 'cancelled', 'internal')
    ),
    error TEXT,
    progress_phase TEXT CHECK (
      progress_phase IS NULL OR
      progress_phase IN ('enumerating', 'counting', 'compressing', 'receiving', 'resolving', 'updating', 'checkout', 'xet')
    ),
    progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100),
    progress_done INTEGER NOT NULL DEFAULT 0 CHECK (progress_done >= 0),
    progress_total INTEGER NOT NULL DEFAULT 0 CHECK (progress_total >= 0),
    created_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    retry_of TEXT REFERENCES clone_tasks(id)
  );
  CREATE INDEX idx_clone_tasks_status_created ON clone_tasks (status, created_at, id);
  CREATE INDEX idx_clone_tasks_retry_of ON clone_tasks (retry_of);
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
