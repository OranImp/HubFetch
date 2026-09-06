# Security

This document describes the security model of HubFetch: how credentials are stored, how the app
isolates privileged work, how clone authentication is bounded, and how diagnostics avoid leaking
secrets.

## Credential storage

- **Token storage**: your Hugging Face User Access Token is encrypted with the OS keychain
  (Electron `safeStorage`) and stored at `%APPDATA%\HubFetch\credentials.json`. The file is written
  atomically with a current-user-only DACL. It is **never** stored in plaintext, in `localStorage`,
  or in the SQLite database.
- **Credential format**: the file uses the encrypted v2 envelope `{ version: 2, cipher }`. The
  encrypted payload contains the active account UUID and all account profiles in one file. Profiles
  bind tokens and optional web sessions to normalized Hub endpoints; no token fingerprint is stored.
- **Recovery**: an unreadable or invalid credential file is atomically renamed to a
  `credentials.corrupt.<UTC-basic-timestamp>.json` backup before the app reports the typed recovery
  state. Backups retain only the newest five and never expose the source path or secret values.
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

## Hub capability stability

The Hub client keeps token-backed operations separate from web compatibility operations. Cookie and
SSR capabilities depend on first-party web-session behavior and may become unavailable independently
of official token-backed browsing, downloads, or administration.

| Capability class  | Credential or source                | Stability                                                        | Expected degradation codes                             |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `official-token`  | Hub access token                    | Official API contract                                            | `unauthorized`, `forbidden`, `rate-limited`, `network` |
| `official-public` | Public Hub API, with optional token | Official public API contract                                     | `network`, `upstream-changed`                          |
| `cookie-web`      | Hub web-session cookie              | Compatibility feature; may change independently                  | `session-required`, `unauthorized`, `upstream-changed` |
| `ssr-scrape`      | Hub-rendered HTML and embedded data | Compatibility feature; HTML changes may disable it independently | `session-required`, `upstream-changed`, `network`      |
| `datasets-server` | Separate datasets-server service    | Separate service contract                                        | `rate-limited`, `upstream-changed`, `network`          |

### Space lifecycle safeguards

Space runtime, pause, resume, restart, hardware, and sleep-time operations are `official-token`
capabilities scoped to the Space owner's token. The renderer can only request them through
validated IPC channels; the main process performs the calls. Destructive or cost-relevant actions
are gated in the UI before any request is sent:

- **Pause** requires an explicit confirmation dialog.
- **Factory rebuild** and **paid hardware changes** require typing the exact repository id, the
  same fail-closed pattern as repository deletion.
- Upgraded-hardware operations state that billing may start immediately — the app renders no
  currency amount and no price estimate anywhere, and the hardware catalog mapper strips the Hub's
  cost fields before they can reach the UI.

Mutations are single-shot: the transport does not retry lifecycle POSTs on server failures, and a
confirmation dialog cannot submit twice while a request is pending.

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

## Secret scanning

HubFetch uses [Gitleaks](https://github.com/gitleaks/gitleaks) to detect accidentally committed
secrets in the repository. Every push and pull request to `main` runs the Gitleaks CI workflow
(`.github/workflows/gitleaks.yml`). Scans are also required before opening a PR.

### Running Gitleaks locally

Gitleaks is not bundled with the repository. Install it from the
[releases page](https://github.com/gitleaks/gitleaks/releases) or via a package manager:

```powershell
# Download and extract (example for v8.30.1)
Invoke-WebRequest -Uri https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_windows_x64.zip -OutFile gitleaks.zip
Expand-Archive -Path gitleaks.zip -DestinationPath C:\tools\gitleaks
# Add C:\tools\gitleaks to your PATH
```

**Full git history scan** (recommended before pushing):

```powershell
gitleaks git --redact --verbose --exit-code=2
```

**Directory-only scan** (fast, no git history):

```powershell
gitleaks dir --redact --verbose .
```

### False positives

If Gitleaks reports a finding that is not a real secret (for example, a synthetic test token), add a
narrow allowlist entry to `.gitleaks.toml` rather than excluding entire files or directories. The
entry should reference the **exact file path** and the **rule ID** being silenced.

```toml
[[allowlist]]
  description = "specific reason"
  paths = ["path/to/file"]
  regex-target = "rule-id"
```

After updating `.gitleaks.toml`, re-run the scan to confirm the false positive is silenced.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting feature on the repository's **Security** tab, or follow the process in
[SECURITY.md](../SECURITY.md).
