# Changelog

All notable changes to HubFetch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Full user, architecture, security, troubleshooting, releasing, and
  contributing documentation with a documentation contract test suite
  (`tests/docs/test_documentation_contracts.py`).

## [0.1.0] - 2026-08-15

### Added

- Windows 11 x64 PySide6 desktop application "HubFetch" with immutable
  identifiers `HubFetch.Desktop`, `HubFetch.Credentials`, and `hubfetch.db`.
- Strict tagged models (Pydantic v2, frozen, `extra="forbid"`) for repository
  type, task specification, lifecycle state, transfer stage, authentication
  source, proxy mode, destination conflict policy, terminal result, persisted
  events, and worker IPC messages; branded `NewType` primitives throughout.
- Transactional SQLite store with versioned settings, tasks, transition
  history, sanitized events, FIFO queue order, and schema migrations
  (schema version 1). Secrets never enter SQLite.
- One global FIFO scheduler: exactly one active task, automatic start of the
  next queued task on terminal states, and startup recovery that changes
  persisted `running`/`cancelling` tasks to `interrupted` before dispatch
  resumes.
- One supervised worker process per active task inside a kill-on-close
  Windows Job Object; PID assignment precedes the task envelope; child
  Git/Xet processes inherit the Job.
- Real cancellation semantics: non-terminal `cancelling`, queued cancellation
  without a worker, cooperative stop then bounded process-tree termination,
  and `cancelled` persisted only after the Job is empty.
- Single-file and filtered/full snapshot downloads through pinned
  `huggingface_hub 1.27.0`, with model/dataset/Space kinds, branch/tag/full
  commit revisions, dry-run estimates, include/exclude patterns, cache and
  local-directory destinations, conflict policies, progress, automatic cache
  resume, and typed error mapping.
- Real Git working-copy clones through system Git and system Git-Xet with
  dependency/version diagnostics, revision/branch input, forced progress
  capture, empty/new destination preflight, Git Credential Manager/SSH
  preference, app-token AskPass fallback, cancellation, and retry-to-empty
  behavior. No custom Git protocol implementation.
- Authentication: anonymous, shared machine browser OAuth behind one pinned
  compatibility adapter, and HubFetch-only manual tokens stored through
  keyring's Windows Credential Manager backend behind opaque aliases.
- Per-task proxy policy: system inheritance, direct mode that clears proxy
  variables in the worker only, and validated manual HTTP/HTTPS proxy seeded
  with `http://127.0.0.1:7897`. GUI/global environment never mutated.
- Cache/disk/dependency diagnostics covering `HF_HOME`, `HF_HUB_CACHE`,
  `HF_XET_CACHE`, Windows symlink degradation, writable paths, free space,
  Git, Git-Xet initialization, credential helpers, endpoint reachability, and
  sanitized support-bundle ZIP export.
- Simplified Chinese default locale with complete English translation
  catalogs; UI literals come from the localization layer.
- "Transfer Ledger" design system defined in `DESIGN.md` (light tokens,
  typography, spacing, motion, accessibility) with a design contract checker.
- Light-first system-theme-aware desktop shell: Tasks, Cache, Diagnostics,
  Settings; separate Download and Clone creation flows; list/detail task
  inspection; accessible transfer-stage rail; keyboard-only operation;
  light/dark/high-contrast; reduced motion; 150-200% scaling; reflow.
- PyInstaller 6.22.0 one-folder Windows x64 package and ZIP with
  `HubFetch.exe`, a console AskPass executable, replaceable Qt DLLs/plugins,
  translations, Cascadia Mono plus OFL, license/notices, LGPL compliance
  documentation, and reproducible build/smoke scripts.

### Changed

- No user-facing behavior changed since the project scaffold; this is the
  first release of the full application.

### Fixed

- No fixes applicable to this initial release.

### Removed

- No features were removed in this initial release.

### Security

- Credential-bearing environment variables (`HF_TOKEN`, `HF_TOKEN_PATH`,
  `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACE_HUB_TOKEN`, `GIT_ASKPASS`,
  `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`) and `hubfetch_`-prefixed variables are
  stripped from every worker environment.
- Fail-closed keyring verification: only the Windows Credential Manager
  backend is accepted; null/fail/plaintext/chainer/`keyrings.alt` backends are
  rejected before any credential operation.
- Structured and pattern redaction of URLs, headers, Git credential lines,
  AskPass prompts, and token patterns; support-bundle export fails closed if a
  registered secret survives.
- No tokens in source, config, SQLite, events, logs, support bundles, argv,
  worker environments, screenshots, or the packaged archive.

[Unreleased]: https://example.com/hubfetch/compare/v0.1.0...HEAD
[0.1.0]: https://example.com/hubfetch/releases/tag/v0.1.0
