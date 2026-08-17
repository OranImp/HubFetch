# Changelog

Release notes for HubFetch. The current product is the Electron-based HubFetch (see
[`README.md`](../README.md) and [`UPSTREAM_SOURCE.md`](../UPSTREAM_SOURCE.md)). Historical entries
below the current release describe earlier states of this codebase and are retained for
provenance only; they do **not** describe the current product.

## 0.2.0 (current)

The Electron HubFetch 0.2.0 release. Highlights since the 0.1.0-era product and the upstream
`v0.0.9` import:

- **Identity & data** — permanent `HubFetch` identifiers and data roots; credentials encrypted with
  `safeStorage` at `%APPDATA%\HubFetch\credentials.json`.
- **Delivery** — single **unsigned Windows x64 ZIP**; no installer; no self-updater; system
  notification registration for Windows.
- **Network** — closed proxy modes (`system` / `direct` / `manual`) applied to both Hub API traffic
  and Git children; per-transfer proxy snapshots; central redaction; fail-closed support-bundle
  export.
- **Native clone bridge** — Job-Object containment of clone trees, utility-process handshake,
  Git/Git-Xet readiness diagnostics, secure Job-bound AskPass, and durable clone scheduling with
  restart recovery.
- **Downloads** — parallel, resumable, SHA-256-verified transfers into the standard HF cache
  layout, independent of the clone subsystem.
- **Remote-write & community** — discussions, collections, notifications, repo and Space
  administration, posts, reactions, upvotes, and profile updates.
- **i18n** — nine locales (en, zh-CN, zh-TW, ja, ko, de, es, fr, pt-BR).

## 0.1.0 (historical)

The pre-cutover PySide6 HubFetch 0.1.0 product (Python 3.12, PySide6, huggingface_hub, PyInstaller
packaging). This is **not** the current product and is retained only in the
`archive/pyside-hubfetch-0.1.0` branch and `v0.1.0-pyside-hubfetch` tag for provenance and
rollback. It used a one-task-at-a-time global queue, Windows Credential Manager token storage, and
a per-task manual proxy seed — none of which reflect current HubFetch behavior.

## Upstream Oh My HuggingFace (historical)

Before the cutover, this repository tracked the upstream Oh My HuggingFace Electron client
(`v0.0.9`). Its cross-platform packaging and self-updater were intentionally removed when the
snapshot was promoted and adapted into HubFetch. See `UPSTREAM_SOURCE.md` for the import provenance.
