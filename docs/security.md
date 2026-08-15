# HubFetch Security Model

This document describes the security boundaries of HubFetch 0.1.0 for
maintainers and reviewers. User-facing privacy notes are in
[user-guide.zh-CN.md](user-guide.zh-CN.md) / [user-guide.en.md](user-guide.en.md);
the component layout is in [architecture.md](architecture.md).

## 1. Threat model in one paragraph

HubFetch moves files and Git clones from the Hugging Face Hub into local
storage. The assets it must protect are: Hugging Face access tokens, machine
credential-helper state, the worker/transfer processes, and the SQLite store
and logs. The design assumes an attacker may read the local disk (databases,
logs, support bundles, screenshots), may control the environment of spawned
processes or inherit a hostile environment, may race cancellation/startup
transitions, and may inspect the packaged archive. It does **not** defend
against an attacker who already controls the user session or the
Credential Manager vault itself.

## 2. Credential boundaries

Three independent authentication sources exist (see the user guides):

1. **Anonymous** — no credentials.
2. **Shared machine browser OAuth** — the token lives only in the Hub's own
   shared storage. HubFetch records non-secret account metadata and never
   writes the token into its credential store, SQLite, or logs.
3. **HubFetch-only manual token** — stored through `keyring`'s Windows
   Credential Manager backend under service `HubFetch.Credentials`, referenced
   by an opaque alias (`hfc-<32 hex>`).

Rules:

- The plaintext token appears only (a) at the input boundary
  (`auth_service.manual_token_login`), (b) inside the worker's in-memory
  resolution during a transfer, and (c) in the Windows Credential Manager
  vault. It is never persisted to SQLite, logs, events, support bundles,
  argv, URLs, screenshots, or environment variables.
- Worker environments strip every credential-bearing variable (`HF_TOKEN`,
  `HF_TOKEN_PATH`, `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACE_HUB_TOKEN`,
  `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`) and every
  `hubfetch_`-prefixed variable before launch.
- Only the opaque alias crosses into the worker (`HUBFETCH_CREDENTIAL_ALIAS`).

## 3. Fail-closed keyring

`credentials/windows_keyring.py` verifies the active keyring backend at
construction: only the Windows Credential Manager implementation
(`WinVaultKeyring`) is accepted. The null, fail, chainer, plaintext, and
`keyrings.alt` backends are rejected with a typed
`CredentialBackendRejectedError` **before any credential operation is
attempted**. There is no plaintext fallback and no `keyrings.alt` dependency.
Bootstrap reports an unavailable backend as a non-fatal degraded diagnostic;
construction of the store itself fails closed.

## 4. Process containment (Job Object)

- Each active task gets exactly one supervised worker process
  (`runtime/supervisor.py`) inside a retained kill-on-close Windows Job
  Object (`platform/windows/job_object.py`).
- Child Git/Xet processes launched by the worker inherit the Job, so the
  whole process tree is contained and terminated together.
- **Job-before-envelope**: the GUI starts a blocked worker, waits for
  `worker_ready`, assigns the PID to the Job, and only then releases the task
  envelope. If assignment fails, the Job is terminated and the task fails
  before any transfer work. No worker/network/Git activity occurs before
  successful assignment.
- Cancellation and app shutdown empty every process tree; the app waits until
  the Job reports zero active processes before committing `cancelled` or
  closing the database.

## 5. Proxy isolation

Per-task proxy policy (`network/proxy.py`) is a closed triple:

- `system` — inherit unchanged.
- `direct` — **only in the worker environment**, clear every proxy variable.
- `manual` — validated HTTP/HTTPS URL (no embedded credentials, no
  path/query/fragment), sets `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` and
  `NO_PROXY=127.0.0.1,localhost`.

The GUI/global machine environment is never mutated; the policy is applied to
a fresh environment copy per worker.

## 6. AskPass trust boundary

`git/auth_policy.py` has exactly two modes. `SYSTEM` (default) adds or
changes nothing. `APP_TOKEN` applies only when the user explicitly selects a
HubFetch credential alias for one git process and:

- disables competing interactive prompts (`GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=Never`),
- neutralizes configured credential helpers for that process via the
  `GIT_CONFIG_*` environment family (no file is mutated),
- points `GIT_ASKPASS`/`SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE=force` at the
  packaged console `HubFetchAskPass.exe` plus the non-secret opaque alias
  locator (`HUBFETCH_ASKPASS_ALIAS`).

The AskPass session is bounded (~30 s) and never holds the token: the helper
resolves it on demand from the vault and writes it only to stdout; unknown
prompts, unknown aliases, and backend failures exit nonzero so Git fails
closed instead of hanging or echoing a secret.

## 7. Redaction

`security/redaction.py` is the single serialization boundary for
diagnostics, events, logs, captured stderr, settings/support output, and
exception chains. See the redaction matrix in
[architecture.md](architecture.md#8-redaction-matrix). Registered secrets are
replaced by value with `[REDACTED]` (longest first) for a bounded context;
the deterministic placeholder is `[REDACTED]`.

## 8. Support bundle exclusions

`diagnostics/support_bundle.py` builds a ZIP from an explicit allowlist:
`versions.json`, `settings.json`, `diagnostics.json`, and allowlisted
`.jsonl`/`.log` files from the configured log directory (per-member cap
1 MiB). It never scans or includes: database/WAL/SHM files, task payload
dumps, environment dumps, screenshots, credentials, full credential aliases,
or arbitrary cache files. Every member passes through the redactor, and an
optional leak guard **fails the export closed** if any registered secret
survives into the archive.

## 9. Persistence and secrets

- SQLite stores versioned settings, tasks, transition history, sanitized
  events, and queue order. Secrets and raw worker environments never enter
  SQLite.
- Task/event payloads are sanitized; `task_events.payload` carries sanitized
  data only.
- The database path is `data_root/hubfetch.db` (application identity
  `HubFetch.Desktop`, database filename `hubfetch.db`); the runtime owner
  lock is `hubfetch.db.lock` beside it.

## 10. Sentinel verification

The security test suite uses the sentinel `hf_test_secret_123` and asserts
byte absence from SQLite files/WAL, logs, events, support ZIP, argv capture,
URLs, QProcess environment snapshots, screenshots, and package files. The
verification seam is `support_bundle.contains_secret` and the smoke
contract's `scan_tree_for_sentinel`. These tests are part of the mandatory
quality gates.

## 11. Scope guardrails (security-relevant)

- No upload, repository create/delete/move/settings/tag/branch mutation, or
  other remote-write feature.
- No GitHub OAuth/PAT storage, GitHub API client, `gh repo create`, invented
  private repository URL, or `origin` remote.
- No MSIX/App Installer/Store submission, certificate generation, elevation,
  installer service, trusted-publisher claim, release API polling, version
  check, background updater, artifact auto-download, or self-update — none of
  these exist in the product.
- No bundled Git, Git-Xet, `hf` CLI dependency, static Qt link, one-file
  freezer mode, UPX, or GPL-only Qt module.
- No destructive overwrite of non-empty destinations; clones require an empty
  or new destination and preserve failed partial data until the user
  explicitly cleans up.
