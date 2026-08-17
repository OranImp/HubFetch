# Security

This document describes the security model of HubFetch: how credentials are stored, how the app
isolates privileged work, how clone authentication is bounded, and how diagnostics avoid leaking
secrets.

## Credential storage

- **Token storage**: your Hugging Face User Access Token is encrypted with the OS keychain
  (Electron `safeStorage`) and stored at `%APPDATA%\HubFetch\credentials.json`. The file is written
  atomically with a current-user-only DACL. It is **never** stored in plaintext, in `localStorage`,
  or in the SQLite database.
- **Web session**: a Hub web session captured through the app is kept in the main process and never
  logged.
- **Relocation**: `HUBFETCH_USER_DATA_DIR` and `HUBFETCH_CREDENTIALS_DIR` relocate the data and
  credentials roots (tests use these for isolation). Deleting the credentials file signs you out
  everywhere.

## Network hygiene

- The `Authorization` header (your token) is only ever sent to `huggingface.co` API hosts, never to
  CDN/`resolve` redirect targets or other hosts.
- Proxy settings are applied without mutating your global Git configuration.
- No telemetry, analytics, or third-party services beyond the Hugging Face API and Git remotes you
  point at.

## Renderer isolation

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP.
- The renderer cannot reach Node.js APIs or the main process directly; it talks only through the
  typed, sender-trusted IPC contract in `packages/shared`.

## Clone authentication boundaries

Git clones authenticate in one of two bounded ways:

1. **System Git** — Git Credential Manager or SSH, exactly as a normal `git clone` on your machine
   would.
2. **App-token AskPass** — a secure, **Job-bound** AskPass helper (`HubFetchAskPass.exe`) provides
   the token for app-token clones. The helper:
   - verifies the requesting PID belongs to the app's own Job Object before answering;
   - never writes the token to disk, environment, logs, or the support bundle;
   - refuses requests from processes that are not the app's clone process.

## Diagnostics & support bundle

- Logs and structured state are redacted by a central redactor before they are exported.
- The support bundle export is **fail-closed**: if any registered secret leaks into the archive,
  the export fails and no archive is produced. Byte budgets and fixed timestamps keep archives
  deterministic and bounded.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting feature on the repository's **Security** tab, or follow the process in
[SECURITY.md](../SECURITY.md).
