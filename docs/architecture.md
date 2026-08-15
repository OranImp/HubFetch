# HubFetch Architecture

Maintainer documentation for HubFetch 0.1.0. User-facing documentation:
[user-guide.zh-CN.md](user-guide.zh-CN.md) (primary, Simplified Chinese) and
[user-guide.en.md](user-guide.en.md). Security model:
[security.md](security.md). The design system contract lives in the root
[DESIGN.md](../DESIGN.md).

## 1. Overview

HubFetch is a Windows 11 x64 PySide6 desktop application that transfers files
from the Hugging Face Hub and clones Git repositories into a local store. It
is composed of six components. The GUI process never performs transfer or
network work; every transfer runs in a contained worker subprocess.

```
desktop-shell ──> task-runtime ──> hub-access ──> hub-download
        │              │                └──> git-clone
        │              └──> delivery-platform (packaging, diagnostics)
        └──> hub-access (settings, auth UI)
```

### 1.1 The six components

| Component | Responsibility | Primary modules |
|---|---|---|
| `desktop-shell` | Windows GUI: navigation, task creation/detail, settings, diagnostics, localization, design system | `ui/`, `app.py`, `i18n/`, `DESIGN.md` |
| `hub-access` | Hub endpoint, authentication sources, proxy policy, secure secret handling, settings persistence | `auth/`, `credentials/`, `network/proxy.py`, `config/` |
| `hub-download` | single-file and filtered/full snapshot transfers with revision and destination semantics | `hub/` |
| `git-clone` | real Git working-copy clones with Git-Xet dependency diagnostics and process control | `git/` |
| `task-runtime` | persistent FIFO queue, progress/events, cancellation, retry, crash recovery, worker supervision | `runtime/`, `application/`, `domain/`, `persistence/`, `platform/windows/` |
| `delivery-platform` | source control, Windows packaging, reproducible release, diagnostics/support export, extension contracts | `packaging/`, `scripts/`, `smoke/`, `diagnostics/` |

## 2. Dependency rules

- **Layer direction**: `desktop-shell` depends on `task-runtime`, `hub-access`,
  and `delivery-platform`; `task-runtime` depends on the transfer components
  (`hub-download`, `git-clone`) and `hub-access` contracts; nothing depends
  upward on `desktop-shell`.
- **GUI-free domain**: `domain/`, `persistence/`, `runtime/` (except the
  `QObject` facades), `hub/`, `git/`, `security/`, and `network/` never
  import `ui/`.
- **One pinned adapter**: only `hub/adapter.py` may import the
  `huggingface_hub` API surface (`HfApi`, `hf_hub_download`,
  `snapshot_download`). All other modules consume its typed methods.
- **Worker entry**: the worker subprocess (`runtime/worker_command.py`)
  accepts only `--worker <session-locator>`; task details travel only inside
  the typed envelope over stdin after Job assignment.
- **Pinned versions**: `pyproject.toml` pins `PySide6==6.11.1`,
  `huggingface_hub==1.27.0`, `PyInstaller==6.22.0` (dev), `requires-python`
  `>=3.12,<3.13`, and bounds `keyring>=25.6,<26` and `pydantic>=2.12,<3`.
  All transitive versions come from the committed `uv.lock`; `uv sync
  --frozen` never silently updates it. See the dependency update procedure in
  [contributing.md](contributing.md).
- **No upload / repository management**: the product scope has no
  remote-write feature. Extension guidance below explains where such a future
  feature would fit **without** adding it.

## 3. Typed contracts

Every external/serialized boundary is parsed once with Pydantic v2
(frozen, `extra="forbid"`); internal values use frozen/slotted dataclasses
and branded `NewType` primitives (`TaskId`, `AttemptId`, `RepositoryId`,
`CredentialAlias`, `HttpUrl`). Key closed unions:

- `TaskSpec`: discriminated union over `single_file` | `snapshot` |
  `git_clone`, each carrying `auth_source` and `proxy_mode`.
- `RepositoryKind`: `model` | `dataset` | `space`; `RepositoryRef` is the
  frozen wire shape (`repo_id`, `kind`, optional `revision`).
- `ConflictPolicy`: `overwrite_existing` | `preserve_existing` |
  `fail_on_existing` (downloads only; clones accept no conflict policy).
- `DestinationMode`: `cache` | `local_directory`.
- `ProxyMode`: `system` | `direct` | `manual`; the parsed policy is
  `SystemProxy | DirectProxy | ManualProxy`.
- `AuthSource`: `anonymous` | `shared_oauth` | `manual_token` (settings use
  `ANONYMOUS` | `BROWSER` | `MANUAL`).
- `LifecycleState` / `LifecycleEvent` / `TerminalResult` / `TransferStage`
  (see section 5).
- Worker IPC: `GuiCommand` variants `StartTaskCommand` | `CancelTaskCommand` |
  `ShutdownCommand`; events incl. `WorkerReadyEvent`, `StageChangedEvent`,
  `ProgressEvent`, `SucceededEvent`, `FailedEvent`, `CancelledEvent`.

No module uses raw `dict`/`Any`/`object` in public signatures, no `cast`,
no `# type: ignore`, and no `# pyright: ignore` except the three scoped
unknown-type directives in `hub/adapter.py` (documented third-party stub
defect). Enum/tag discrimination is exhaustive `match` with
`assert_never`.

## 4. SQLite schema and migrations

The store is transactional SQLite at `data_root/hubfetch.db`, owned by
`persistence/connection.py` and migrated by `persistence/migrations.py`
(current schema version **1**). Secrets and raw worker environments never
enter SQLite; only sanitized events and non-secret values are persisted.

Migration `001_initial.sql` (each migration runs in one transaction):

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);

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
CREATE INDEX idx_task_transitions_task ON task_transitions(task_id, transition_id);

CREATE TABLE task_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    attempt_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, occurred_at, event_id);

INSERT INTO schema_version (version, applied_at) VALUES (1, '2026-01-01T00:00:00+00:00');
```

Rules: a new migration appends `00N_*.sql`; the runner applies pending
migrations inside transactions; an unsupported (too new) schema version is a
typed `UnsupportedSchemaVersionError` and startup fails closed. WAL mode is
used; the settings saver opens a second WAL connection.

## 5. Lifecycle and transfer stages

### 5.1 Lifecycle state machine

The legal table is encoded explicitly in `domain/lifecycle.py`:

```
queued     -> running | cancelled
running    -> cancelling | succeeded | failed | interrupted
cancelling -> cancelled | failed | interrupted
```

- `cancelling` is non-terminal; `cancelled` is written only after the Job is
  empty and the final event is committed.
- `failed`, `cancelled`, and `interrupted` return to `queued` only through
  `retry_attempt`, which creates a brand-new linked attempt. `succeeded`
  never retries.
- Any transition absent from the table raises a typed
  `IllegalTransitionError`; a new state fails loudly at the boundary.

### 5.2 Transfer stages

Fixed report ordering (subset/omission allowed per kind, never reordering):

```
preflight -> authenticate -> resolve -> transfer -> materialize -> finalize
```

For Git clones the observable stages are `preflight` → `transfer` →
`materialize` (the `UPDATING` phase) → `finalize`; object counts are reported
through the transport's monotonic `bytes_done`/`bytes_total` fields.

## 6. Task runtime: scheduler, supervision, and IPC

### 6.1 FIFO scheduler and recovery

`runtime/scheduler.py` owns the single global queue. Dispatch never proceeds
before (1) startup recovery and (2) the diagnostics gate complete. Claim is a
compare-and-set (`queued -> running`), so racing ticks commit at most one
transition. `Runtime.start` acquires the single-owner file lock
(`hubfetch.db.lock`) before recovery; a second runtime instance is refused.
`recover_interrupted()` changes persisted `running`/`cancelling` rows to
`interrupted` exactly once, then dispatch resumes FIFO.

### 6.2 Job-before-envelope sequence

1. The GUI launches a blocked worker via `QProcess` with a sanitized
   environment; the worker emits one `worker_ready` event and blocks on stdin.
2. The supervisor assigns the live worker PID to the retained kill-on-close
   Windows Job Object (`platform/windows/job_object.py`).
3. **Only after assignment** the GUI sends the non-secret task envelope
   (`StartTaskCommand` with the full `TaskSpec`) over stdin.
4. The worker then performs transfer work. If assignment fails, the Job is
   terminated and the task fails before any work (`running -> failed` via
   `StateMismatchError`-guarded CAS), so no task claims `running` when no
   work was done.
5. Child Git/Xet processes launched by the worker inherit the Job, so the
   whole tree is contained.

### 6.3 Cancellation ordering

`runtime/cancellation.py` drives active cancellation:

1. CAS-commit `running -> cancelling`.
2. Send exactly one `CancelTaskCommand` to the worker.
3. Wait the grace period for a cooperative ack (`cancelled` terminal event).
4. On timeout or send failure, escalate with `TerminateJobObject`
   (bounded process-tree termination).
5. Poll the Job (25 ms interval) until it reports zero active processes or
   the confirm deadline expires.
6. Only then CAS-commit `cancelling -> cancelled` (or `failed`/`interrupted`
   per outcome) and record the final event. Races terminalize exactly once.

Queued tasks cancel through the CAS command path with no worker launch.

### 6.4 Shutdown

`Runtime.shutdown` stops dispatch, terminates every active Job, observes the
empty-Job condition, and closes the SQLite connection only after every Job
reports zero active processes. The GUI wait is bounded (10 s) and the worker
tree is killed on close.

## 7. AskPass trust boundary

`git/auth_policy.py` has exactly two closed modes:

- `SYSTEM` (default): leaves SSH to the user's agent/config and HTTPS to Git
  Credential Manager or the configured safe helper. Adds or changes nothing.
- `APP_TOKEN`: selected only when the user explicitly chooses a HubFetch
  credential alias for one git process. For that process it disables
  competing interactive prompts (`GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=Never`), neutralizes configured credential helpers via the
  `GIT_CONFIG_*` environment family (no file is mutated), and points
  `GIT_ASKPASS`/`SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE=force` at the packaged
  console `HubFetchAskPass.exe` with a non-secret opaque alias locator
  (`HUBFETCH_ASKPASS_ALIAS`).

The environment never carries the token: `askpass_session.py` binds one alias
to one git invocation inside a ~30 s lifetime, and the helper resolves the
token from Windows Credential Manager on demand, writing it only to stdout.
Sanitized support output replaces the alias with `[REDACTED]` too.

## 8. Redaction matrix

`security/redaction.py` is the single serialization boundary. Applied to
diagnostics, events, logs, captured stderr, settings/support output, and
exception chains:

| Input | Rule | Example |
|---|---|---|
| HTTP(S) URL | redact userinfo, keep host/port | `https://[REDACTED]@host` |
| Query parameter values | redact by sensitive name | `?token=[REDACTED]` |
| Header lines | redact by name | `Authorization: [REDACTED]` |
| Git credential lines | redact after `password=`/`token=` | `password=[REDACTED]` |
| AskPass prompt echoes | redact echoed value | `token for 'x': [REDACTED]` |
| `hf_` / `api_org_` tokens | pattern redaction | `hf_...` → `[REDACTED]` |
| Registered secrets | replace by value, longest first | any registered string → `[REDACTED]` |
| Structured fields | redact by sensitive field name | `{"token": "[REDACTED]"}` |

A `SecretRegistry` keeps registered secrets for a bounded context; support
bundle export fails closed if a registered secret survives.

## 9. Localization and design workflow

- Catalogs: committed Qt XML sources `resources/i18n/hubfetch_zh_CN.ts`
  (primary, Simplified Chinese) and `hubfetch_en_US.ts` (complete English).
  UI literals come only from the localization layer
  (`i18n/catalog.py`): lookup order is current locale → fallback locale →
  message ID, never an empty string.
- Compile with `.venv\Scripts\pyside6-lrelease.exe` via
  `scripts\compile_translations.ps1` (or the build script); `.qm` outputs are
  gitignored. Both `.qm` files ship in the package.
- Design: the root `DESIGN.md` defines the "Transfer Ledger" system — light
  tokens (`#202124`, `#F7F8FA`, `#FFFFFF`, `#D9DEE7`, `#FFD21E`, `#2563EB`),
  Segoe UI Variable + Microsoft YaHei UI + bundled Cascadia Mono (OFL),
  4/8 px spacing, radii ≤ 8 px, borders-only depth, Lucide icons, one custom
  expressive control (the transfer-stage rail), 83–167 ms motion with
  reduced-motion behavior, and keyboard/contrast/high-contrast/200% scaling
  rules. `scripts/check_design_contract.py` enforces the contract; the
  primitive/state showcase must pass visual QA before product screens are
  composed.

## 10. Packaging and reproducible release

`packaging/hubfetch.spec` is declarative (validated without execution by
`scripts/check_package_policy.py`):

- Two executables in one `dist/HubFetch/` COLLECT tree: `HubFetch.exe`
  (windowed) and `HubFetchAskPass.exe` (console).
- Qt/PySide6 DLLs and plugins are loose, dynamically replaceable files under
  `_internal/PySide6/`; no one-file, no static Qt, no UPX.
- GPL-only and unused heavy Qt modules are excluded (`EXCLUDES` in the spec,
  `packaging/hooks/hook-hubfetch.app.py`).
- Resources (fonts, icons, translations, SQL migrations, license texts, Qt
  LGPL compliance docs) are pinned in the `RESOURCE_PLAN`.

Release checklist: see [releasing.md](releasing.md). Every release runs the
mandatory gates, regenerates `THIRD_PARTY_NOTICES.md` from `uv.lock`, runs
the package policy, builds with `scripts\build_windows.ps1 -Frozen`, and
smokes the archive with `scripts\smoke_portable.ps1` (clean PATH, isolated
app-data root, `--smoke-test`, GUI capture, PE/import/sentinel/orphan
checks).

## 11. Comment standard

Comments must explain **why/contract/risk**, never narrate obvious
assignments or control flow. Required rationale comments exist for: the
explicit lifecycle transition table, Win32 Job/IPC ordering, credential
boundaries, `recover_interrupted`, cancellation escalation ordering, the
redaction serialization boundary, and non-obvious invariants. Module and
public API docstrings use Google style (ruff `pydocstyle` google convention).

## 12. Extension guidance (future features, not implemented)

This section documents **no** upload or repository-management feature in
the product; it only explains how future features would fit — **not** to
promise them. None are implemented today.

- A future upload feature (not implemented) would add a new `TaskSpec`
  variant (e.g. `single_file_upload`) in `domain/task_spec.py` plus an
  exhaustive handler in `worker/dispatch.py`, a new `hub/` adapter method
  (the only module that may touch `huggingface_hub`), and a new UI flow under
  `ui/create/`. The lifecycle, queue, containment, and redaction machinery
  would be reused unchanged.
- Repository create/delete/move/settings (none implemented) would extend the
  `hub-access` component with adapter methods and UI surfaces; they would
  **not** touch the transfer runtime.
- Scope guardrails remain: no GitHub OAuth/PAT storage, no GitHub API client,
  no `origin` remote, no installer/MSIX/signing/elevation, no update
  mechanism, no bundled Git/Git-Xet/hf CLI, and no secrets in environment,
  argv, SQLite, or support output.
