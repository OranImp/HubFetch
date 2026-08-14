-- HubFetch persistence schema, migration 001.
-- Every statement below runs inside one explicit transaction by the
-- migration runner; a failure anywhere rolls the whole migration back.

CREATE TABLE schema_version (
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    position INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE task_transitions (
    transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    attempt_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    event_kind TEXT
);

CREATE INDEX idx_task_transitions_task
    ON task_transitions(task_id, transition_id);

CREATE TABLE task_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    attempt_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
);

CREATE INDEX idx_task_events_task
    ON task_events(task_id, occurred_at, event_id);

INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00+00:00');
