-- End-state HubFetch profile schema for visual-regression seeds.
-- user_version = 5 matches apps/desktop/src/main/db.ts MIGRATIONS.length.
PRAGMA journal_mode = WAL;
PRAGMA user_version = 4;

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
  completed_at TEXT,
  resolved_commit TEXT,
  endpoint TEXT,
  proxy_url TEXT,
  cache_dir TEXT,
  environment_version INTEGER,
  error_code TEXT,
  proxy_mode TEXT,
  account_id TEXT,
  account_label TEXT
);
CREATE TABLE follows (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  legacy_origin TEXT,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_checked_at TEXT,
  state_json TEXT
);
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  legacy_origin TEXT,
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
CREATE TABLE clone_tasks (
  id TEXT PRIMARY KEY,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  repo_kind TEXT NOT NULL CHECK (repo_kind IN ('model', 'dataset', 'space')),
  repo_id TEXT NOT NULL CHECK (length(repo_id) BETWEEN 1 AND 255),
  revision_json TEXT CHECK (revision_json IS NULL OR json_valid(revision_json)),
  transport TEXT NOT NULL CHECK (transport IN ('https', 'ssh')),
  destination TEXT NOT NULL CHECK (length(destination) BETWEEN 1 AND 1024),
  auth TEXT NOT NULL CHECK (auth IN ('none', 'app-token', 'system')),
  account_id TEXT,
  account_label TEXT,
  proxy_mode TEXT NOT NULL CHECK (proxy_mode IN ('system', 'direct', 'manual')),
  proxy_url TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted')
  ),
  error_code TEXT,
  error TEXT,
  progress_phase TEXT,
  progress_percent INTEGER NOT NULL DEFAULT 0,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  retry_of TEXT REFERENCES clone_tasks(id)
);
CREATE INDEX idx_inbox_created ON inbox (created_at DESC);
CREATE INDEX idx_inbox_account_created ON inbox (account_id, created_at DESC);
CREATE INDEX idx_follows_account_created ON follows (account_id, created_at);
CREATE UNIQUE INDEX idx_follows_scope_target
  ON follows (COALESCE(account_id, 'legacy-local'), type, target);
CREATE INDEX idx_clone_tasks_status_created ON clone_tasks (status, created_at, id);
CREATE INDEX idx_clone_tasks_retry_of ON clone_tasks (retry_of);
