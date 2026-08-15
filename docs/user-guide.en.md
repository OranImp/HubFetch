# HubFetch User Guide (English)

This is the English counterpart of the primary documentation, which is
maintained in Simplified Chinese: [user-guide.zh-CN.md](user-guide.zh-CN.md).
Maintainer documentation lives in [architecture.md](architecture.md) and
[security.md](security.md).

HubFetch is a Windows 11 x64 desktop application for managing local Hugging
Face download and Git clone workflows. It is an independent project and is
not affiliated with or endorsed by Hugging Face, Inc.

> **Important**: HubFetch is released as an **unsigned** portable ZIP. The
> first launch shows a Windows SmartScreen warning. Choose "More info → Run
> anyway" only if you trust the source of the archive. The software ships no
> installer, performs no signing and requests no elevation, and provides no
> update mechanism (no update check, no release polling, no background
> updater).

## 1. Requirements and prerequisites

- **OS**: Windows 11 x64 (build >= 22000).
- **Python**: Python 3.12 is required only for development and building; the
  released portable archive needs no installed Python.
- **uv**: development and building only.
- **Git**: required at runtime for clone tasks.
- **Git-Xet**: required at runtime for repositories stored with Xet;
  download-only tasks do not need it.

### Installing Git and Git-Xet without elevation (winget)

The following commands run as an unprivileged user; they need no
administrator rights and do not trigger UAC:

```powershell
winget install --id Git.Git -e
winget install --id git-xet.git-xet -e
```

Git for Windows also installs Git Credential Manager, so HTTPS authentication
can reuse machine credentials. Open a new terminal afterwards and confirm:

```powershell
git --version
git xet --version
```

Clone tasks additionally require the Git-Xet filters to be initialized
(`git xet init`). If the Diagnostics page reports "Git-Xet is missing or its
filters are not configured", follow [troubleshooting.md](troubleshooting.md).

## 2. Installation and extraction

1. Download `HubFetch-0.1.0-windows-x64.zip`.
2. Extract it to a folder. Paths may contain spaces or non-ASCII characters
   (for example `便携 测试`); the archive contains a top-level `HubFetch`
   directory.
3. The directory holds `HubFetch.exe` (the GUI), `HubFetchAskPass.exe` (the
   console helper), `_internal/` (libraries), `licenses/` (license texts),
   `resources/` (fonts and icons), and more. Do **not** delete `_internal/`
   or its DLLs/plugins — they are part of the runtime and are replaceable
   (see the Qt LGPL compliance note `qt-lgpl-compliance.md`).
4. Double-click `HubFetch.exe` to start.

On first launch the application **creates its data directory** and the
`hubfetch.db` database (see section 11). These live in the user data
directory, not the install folder, so uninstalling leaves nothing behind at
the installation location.

## 3. First launch and the unsigned-app warning

- Because the archive is unsigned, SmartScreen may show "Windows protected
  your PC". Click "More info", and only if you trust the source, choose "Run
  anyway".
- The interface defaults to **Simplified Chinese**; switch to English in
  Settings.
- At startup, recoverable issues (Git/Git-Xet readiness, writable cache,
  keyring backend) are reported as non-blocking status banners and never
  prevent download-only tasks.

## 4. Authentication

HubFetch supports three independent authentication sources:

### 4.1 Anonymous (default)

No credentials; only public repositories. This is the default.

### 4.2 Shared machine browser OAuth

Uses the official Hugging Face "shared machine login" browser OAuth. After
sign-in the token lives only in the Hub's own shared storage; HubFetch never
writes it into its own credential store or database, and records only
non-secret account metadata. This path depends on a pinned Hugging Face
adapter; if it is unavailable in the current environment the UI shows a
compatibility diagnostic while the manual-token path stays fully usable.

### 4.3 HubFetch-only manual token

- Enter a Hugging Face access token (`hf_...`) in Settings.
- The token is stored through Windows Credential Manager under the service
  name `HubFetch.Credentials` and is referenced only by an **opaque alias**
  (a random `hfc-`-prefixed value).
- The plaintext token never appears in the database, logs, events, support
  bundles, process arguments, or worker environments.
- Do **not** configure tokens through environment variables: credential-
  bearing variables such as `HF_TOKEN` are stripped from every worker
  environment. Do not `set HF_TOKEN` in any terminal.

### 4.4 Authentication for clone tasks

- Default (`system`) mode: HTTPS uses Git Credential Manager or your
  configured safe helper, SSH uses your agent/config; HubFetch changes
  nothing.
- When you explicitly select a HubFetch credential alias for a clone task,
  that git process disables competing interactive prompts
  (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never`, and neutralized
  credential helpers) and points `GIT_ASKPASS`/`SSH_ASKPASS` at the packaged
  `HubFetchAskPass.exe`. The AskPass session is valid for about 30 seconds
  and never holds the token — the helper resolves it on demand from the
  credential store and writes it only to stdout.

## 5. Proxy settings

Each task can select an independent proxy policy (chosen at task creation;
the global setting only stores the default):

- **System proxy**: inherit the machine/system proxy settings, changing
  nothing.
- **Direct mode**: clears every proxy variable only inside that task's worker
  environment; the GUI and global environment are never modified.
- **Manual proxy**: a validated HTTP/HTTPS proxy URL (default seed
  `http://127.0.0.1:7897`). Manual mode sets `HTTP_PROXY`, `HTTPS_PROXY`, and
  `ALL_PROXY`, and explicitly sets `NO_PROXY=127.0.0.1,localhost` so local
  traffic bypasses the proxy. URLs must not embed usernames or passwords.

Direct and manual modes affect only task processes; they never change your
system proxy configuration.

## 6. Downloads: files and snapshots

### 6.1 Single-file download

Downloads **one file** from a repository. Requires the repository id
(`author/repo`), the repository type (model / dataset / Space), an optional
revision (branch, tag, or full commit hash), and the filename.

### 6.2 Snapshot download

Downloads a **filtered or full snapshot**. You can specify include/exclude
patterns (glob style), for example only `*.safetensors`, and choose a branch,
tag, or full commit hash.

### 6.3 Destination and conflict policy

Download destinations are one of:

- **Cache mode**: files land in the versioned Hugging Face Hub cache
  (`HF_HUB_CACHE`).
- **Local directory mode**: files also land in a directory you choose.

Conflict policies:

- **Overwrite**: existing destination files are replaced by fresh downloads.
- **Preserve**: existing files are kept and skipped.
- **Fail**: the task fails rather than touch an existing destination file.

Downloads resume automatically from the Hub cache: retrying an interrupted
download against the same cache does not re-fetch completed bytes. A dry-run
can estimate file counts and bytes before downloading.

### 6.4 Semantics: download vs clone

- A download produces **files/snapshots**: organized as the Hub cache plus an
  optional local directory, not a Git working copy. Use it when you only need
  weights or data.
- A clone produces a **full Git working copy** with `.git/`, a working tree,
  and version history, for workflows that keep using `git`.

## 7. Clones: Git working copies

- Clones run through **system Git** and **system Git-Xet** (HubFetch
  implements no custom Git protocol and bundles no Git/Git-Xet binaries).
- You can select a revision (branch/tag, as supported by Git) and optionally
  request a shallow clone (`--depth 1`).
- **The destination must be an empty or non-existent directory.** A non-empty
  destination fails the task.
- **An interrupted clone does not resume in place** (Git has no resumable
  clone). On retry choose a new (or emptied) destination; partial data from a
  failed clone is preserved where it is until you explicitly clean it up.
- Clone progress is forced from stderr and shown as transfer stages
  (preflight → transfer → materialize → finalize).

## 8. Queue, cancel, retry, and interrupted recovery

- **Global FIFO queue**: a confirmed task enters `queued`; **exactly one task
  is active**; the next queued task starts automatically after the current
  task reaches a terminal state (succeeded / failed / cancelled /
  interrupted).
- **Cancel**:
  - Queued tasks cancel without launching a worker.
  - Active tasks first enter the non-terminal `cancelling` state; a
    cooperative stop request is sent to the worker, with a grace window. If
    the worker does not respond, a **bounded** process-tree termination
    (`TerminateJobObject`) follows. `cancelled` is persisted only after the
    Job reports zero active processes and the final event is recorded.
- **Retry**: failed, cancelled, and interrupted terminal tasks can be
  retried. A retry creates a **fresh linked attempt**. Succeeded tasks never
  retry. Download retries reuse the cache; clone retries require an empty or
  new destination.
- **Interrupted recovery**: if the app exits during a transfer, the Job's
  kill-on-close terminates the whole worker tree, and persisted
  `running`/`cancelling` rows become `interrupted` on the next startup before
  FIFO dispatch resumes.

## 9. Cache and disk diagnostics

The Diagnostics page provides read-only checks:

- Actual locations and writability of `HF_HOME`, `HF_HUB_CACHE`, and
  `HF_XET_CACHE`.
- Windows symlink support (degraded symlinks on some systems/file systems can
  affect cache layout).
- Free-space estimates for destination drives.
- Git availability, Git-Xet initialization, and credential-helper readiness.
- Hub endpoint reachability.
- Support-bundle export (next section).

## 10. Support bundle

A support bundle is a ZIP containing **only**:

- `versions.json`: application/runtime/dependency versions.
- `settings.json`: sanitized settings.
- `diagnostics.json`: sanitized diagnostic report.
- `logs/*.jsonl` and `logs/*.log`: allowlisted log files from the log
  directory (per-member cap 1 MiB; longer logs are truncated and marked).

It **never** contains: database/WAL/SHM files, task payload dumps, environment
dumps, screenshots, credentials, full credential aliases, or arbitrary cache
files. Every member passes through redaction before serialization; if a
registered secret would survive into the archive, the export **fails closed**
instead of producing a leaking bundle.

## 11. Privacy and security boundaries

- **Credentials**: manual tokens live only in Windows Credential Manager
  (service `HubFetch.Credentials`); the database and logs hold only opaque
  aliases and account metadata. OAuth tokens live in the Hub's shared
  storage and are never touched by HubFetch.
- **Environment isolation**: every worker uses a fresh environment built from
  a read-only parent snapshot; credential-bearing variables (`HF_TOKEN`,
  `HF_TOKEN_PATH`, `HUGGING_FACE_HUB_TOKEN`, `HUGGINGFACE_HUB_TOKEN`,
  `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`) and all
  `hubfetch_`-prefixed variables are removed.
- **Process containment**: one supervised worker per active task inside a
  kill-on-close Windows Job Object; child Git/Xet processes inherit the Job.
  Cancellation and shutdown empty the whole process tree.
- **Job before envelope**: the GUI starts a blocked worker, assigns its PID
  to the Job, and only then sends the task envelope; if assignment fails,
  work is refused.
- **Redaction**: logs, events, support bundles, and captured stderr are
  structurally and pattern-redacted (URL userinfo, sensitive query
  parameters, headers such as `Authorization`, Git credential-protocol
  lines, AskPass prompt echoes, `hf_`/`api_org_` token patterns, and
  registered secrets replaced by value with `[REDACTED]`).
- **Fail-closed keyring**: if the active keyring backend is not the Windows
  Credential Manager implementation (null/fail/plaintext/chainer/
  `keyrings.alt`, etc.), constructing the credential store is refused rather
  than degrading to plaintext storage.

## 12. Known limitations

- Unsigned release: no trusted signature; SmartScreen warns.
- No update mechanism: no check, no polling, no self-update, no
  auto-download — none of these exist in the product.
- No upload or repository management: cannot upload, create, delete, move,
  or configure repositories, and cannot modify tags or branches.
- Clones do not resume in place; a retry needs an empty or new destination.
- Shared browser OAuth depends on the pinned Hub adapter; when the adapter is
  unavailable that path is unavailable.
- Exactly one active task (the queue runs serially).
- Does not bundle Git, Git-Xet, or any Hugging Face command-line tool.
- Windows symlinks may degrade on some file systems/configurations, which can
  affect cache layout.

## 13. Troubleshooting

Full step-by-step guidance is in [troubleshooting.md](troubleshooting.md).
Quick reference:

| Symptom | Action |
|---|---|
| SmartScreen warning | Unsigned is expected; trust the source, then "Run anyway" |
| Clone fails: Git not ready | Install Git so `git` is on PATH; non-elevated `winget install --id Git.Git -e` |
| Clone fails: Git-Xet missing | Install Git-Xet and initialize filters (`git xet init`) |
| Clone fails: destination is not empty | Choose a new or emptied destination directory |
| Private/gated repo 401/403 | Select the manual-token or shared-OAuth auth source |
| Download stalls or is slow | Choose direct or manual proxy mode for the task |
| Task still shows running after cancel | Wait for the grace window and bounded termination; `cancelled` is written only after the Job empties |
| Need support | Export a support bundle from Diagnostics and hand the ZIP to a maintainer (it contains no credentials) |

## 14. Uninstall and data/credential cleanup

- **Uninstall**: HubFetch has no installer. Deleting the extracted folder
  uninstalls it; no administrator rights are needed.
- **Data**: application data (including `hubfetch.db`, cache, and logs) lives
  in the user data directory (the HubFetch location under AppData); removing
  the app does not remove it automatically. Delete that directory manually
  for a full cleanup. Diagnostics shows the resolved cache path.
- **Credentials**: delete the token alias in the app's credential
  management, or remove the `HubFetch.Credentials` entry under Windows
  Credential Manager (Control Panel → Credential Manager → Windows
  Credentials).
- **Environment**: nothing to clean; HubFetch never modifies the global
  environment.

## 15. Licenses

- Application: MIT (`licenses/LICENSE`).
- Third-party components: `licenses/THIRD_PARTY_NOTICES.md` (generated
  deterministically from `uv.lock`).
- Qt/PySide6: LGPL-3.0-only (dynamically linked; DLLs and plugins are
  replaceable), compliance note `qt-lgpl-compliance.md`; GPL-3.0 text is also
  shipped.
- Fonts: Cascadia Mono under the SIL Open Font License 1.1
  (`resources/fonts/OFL.txt`).

## 16. No-update behavior

HubFetch **never** polls for releases, checks for new versions, downloads
updates in the background, and never self-updates silently or shows update
prompts — none of these behaviors exist.
The only release-related behavior is: when the user explicitly configures a
Help URL in Settings, the Help action opens that URL in the default browser.
Without such configuration there is no network access at all.
