# UPSTREAM_SOURCE.md — import provenance for HubFetch

This file records where the HubFetch codebase came from, how it was modified, and where the
pre-cutover history lives. It satisfies the Apache-2.0 redistribution requirement that source
provenance and modifications be disclosed.

## Source

- Upstream repository: `https://github.com/fzlzjerry/ohmyhf.git`
  (alias `oh-my-hf/ohmyhf`; the original plan-literal `huggingface/oh-my-huggingface` URL returns
  404 and was corrected by the project owner on 2026-08-16 — see Todo 2 correction-verdict.json).
- Upstream release tag: `v0.0.9` (upstream commit `3bdf5d6027395bb2bbdd611930012712edf8d7b0`).
- Imported snapshot: the **untouched upstream v0.0.9 snapshot** promoted to this repository root at
  the cutover commit `chore(repo): promote ohmyhf snapshot to repository root` (2026-08-16). No
  source file was modified, rebranded, or adapted in that commit itself.

## License

- `Apache-2.0` (see `LICENSE` in this repository root; identical to the upstream file).
- Upstream is an independent community project and is not affiliated with or endorsed by Hugging
  Face, Inc. HubFetch is likewise independent of Hugging Face, Inc.

## Modification statement

The imported v0.0.9 snapshot has since been adapted into **HubFetch 0.2.0**, an independent
Electron fork. The complete list of divergences is tracked across the commit history and in the
archive refs below, but the substantive product changes since the untouched import are:

- **Identity & data (Todos 12–14):** permanent identifiers and data roots under the `HubFetch`
  brand; the application identity, credentials path (`%APPDATA%\HubFetch\credentials.json`), and
  UI/icon/branding were rebranded from the upstream `Oh My HuggingFace` name.
- **Delivery (Todos 15–17):** system notification registration for Windows; the self-updater was
  removed; packaging is a single **unsigned Windows x64 ZIP** with no installer and no
  multi-platform targets.
- **Network (Todos 19–24):** closed proxy persistence with `system` / `direct` / `manual` modes,
  transport-level proxy behavior, per-task proxy snapshots, a central redaction registry, and a
  fail-closed Diagnostics + support-bundle export.
- **Native clone foundation (Todos 25–31):** a native Windows process bridge (Job Object
  containment), a utility-process handshake, Git/Git-Xet readiness diagnostics, a typed clone
  command/progress contract, a secure Job-bound AskPass helper, and clone persistence/recovery.
- **Clone product integration (Todos 32–38):** a durable clone scheduler, typed IPC/preload, clone
  create flow, task views/actions, a deterministic test matrix, and packaged native/AskPass/orphan
  smoke verification.
- **Concurrency model:** downloads and clones are **separate** subsystems with independent
  concurrency; clone work is one-at-a-time under a durable scheduler while the download manager
  runs its own parallel queue.

Because this document is a provenance record, it intentionally does not repeat the full feature
list; see `README.md` and `docs/architecture.md` for the current product behavior. Historical
release notes, including the pre-cutover PySide6-era product, live in `docs/changelog.md`.

## Archive references (pre-cutover PySide6 HubFetch)

- Branch: `archive/pyside-hubfetch-0.1.0`
- Tag: `v0.1.0-pyside-hubfetch`
- Both pinned to the pre-cutover commit `6ce8808f64da9935c8612b28c9306f54ad0b4cc1`.
- The archive branch contains the older PySide6 HubFetch 0.1.0 product (MIT-licensed at that time),
  its own `THIRD_PARTY_NOTICES.md`, docs, and Python/PyInstaller packaging. It is retained for
  provenance and rollback only and is **not** the current product.

## Upstream read-only workflow

The upstream remote is kept **read-only** (`https://github.com/fzlzjerry/ohmyhf.git`). All HubFetch
development happens in this repository. The upstream is never pushed to; any future upstream sync is
a manual, reviewed merge documented in `docs/upstream-sync.md`.

## Cutover facts

- Date: 2026-08-16
- Pre-cutover SHA: `6ce8808f64da9935c8612b28c9306f54ad0b4cc1`
- Imported inventory: 493 files (see `.omo/evidence/task-3-adopt-ohmyhf-main/incoming-manifest.json`)
- Cutover commit: `chore(repo): promote ohmyhf snapshot to repository root`
