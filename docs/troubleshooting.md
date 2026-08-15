# HubFetch Troubleshooting

Step-by-step guidance for common HubFetch 0.1.0 issues. The primary user
documentation is [user-guide.zh-CN.md](user-guide.zh-CN.md) (Simplified
Chinese) with the English counterpart
[user-guide.en.md](user-guide.en.md).

## 1. Startup issues

### 1.1 SmartScreen "Windows protected your PC"

The portable archive is **unsigned**; this warning is expected on first run.
Read the warning, and only if you trust the source of the archive, choose
"More info" → "Run anyway". There is no installer, no signing, and no
elevation.

### 1.2 Fatal startup failure dialog

If the GUI shows a fatal error box, startup failed completely (typed
`FatalStartupError`) and nothing was partially composed. Common causes:

- **Persistence unavailable**: `hubfetch.db` cannot be opened or migrated.
  Check that the data directory is writable and that no other HubFetch
  instance holds the runtime-owner lock (`hubfetch.db.lock`). Only one
  instance may run at a time.
- **Runtime owner unavailable**: another HubFetch process is already running.
  Close it and retry.

### 1.3 Non-blocking degraded banners

Recoverable concerns appear as status banners but do not block the app:
`git_unavailable`, `xet_degraded`, `cache_not_writable`, and
`keyring_rejected`. See the relevant sections below.

## 2. Git and Git-Xet

### 2.1 "Git is not ready" on clone

Install Git as an unprivileged user and ensure `git` is on `PATH`:

```powershell
winget install --id Git.Git -e
```

Open a new terminal and confirm:

```powershell
git --version
```

### 2.2 "Git-Xet is missing or its filters are not configured" (xet_degraded)

Install Git-Xet and initialize its filters:

```powershell
winget install --id git-xet.git-xet -e
git xet init
```

Download-only tasks do not need Git-Xet; only clones of Xet-backed
repositories do.

### 2.3 "destination is not empty"

Git clones require an **empty or non-existent** destination directory.
Choose a new directory, or empty the existing one yourself. HubFetch never
deletes or overwrites a non-empty destination, and a clone never resumes in
place; partial data from a failed clone is preserved until you explicitly
clean it up.

### 2.4 Authentication failure during clone

- If you did not select a HubFetch credential alias, the git process uses the
  `system` mode: Git Credential Manager or your configured safe helper for
  HTTPS, your SSH agent/config for SSH. Make sure those are set up.
- For a private/gated repository, select a HubFetch manual token or the
  shared browser OAuth as the task's auth source.
- App-token clones disable interactive prompts; if the alias is missing or
  the vault is unavailable, the AskPass helper exits nonzero and git fails
  closed rather than hanging.

## 3. Downloads

### 3.1 "destination already contains the target" (fail_on_existing)

The task used the `fail_on_existing` conflict policy and the destination
already holds the target file. Choose `overwrite_existing` or
`preserve_existing`, or pick a different destination.

### 3.2 Private/gated repository 401/403

Anonymous access cannot read private or gated repositories. Select a manual
token (stored in Windows Credential Manager under `HubFetch.Credentials`) or
the shared browser OAuth source, then retry. The error mapping distinguishes
"you are not authenticated" from "the repository is gated for this account".

### 3.3 Slow or stalled downloads

Try a different proxy mode for the task:

- **Direct mode** clears proxy variables only inside that worker.
- **Manual proxy** sends traffic through `http://127.0.0.1:7897` (or the URL
  you configure) with `NO_PROXY=127.0.0.1,localhost`.
- **System mode** inherits machine proxy settings.

A retry against the same cache resumes completed bytes automatically.

## 4. Cancellation and recovery

### 4.1 A cancelled task still shows running

`cancelling` is non-terminal. The worker receives a cooperative stop, then a
bounded escalation (`TerminateJobObject`) if needed; `cancelled` is persisted
only after the Job reports zero active processes and the final event is
recorded. Wait briefly; if it never settles, the confirm timeout fails the
attempt as `failed` or `interrupted`.

### 4.2 Tasks became interrupted after a crash

This is correct behavior: if the app exits during a transfer, the Job's
kill-on-close terminates the worker tree, and persisted `running`/`cancelling`
rows become `interrupted` on the next startup before FIFO dispatch resumes.
Retry the interrupted task: downloads reuse the cache; clones need a new or
emptied destination.

### 4.3 Queue seems stuck

Dispatch is blocked until startup recovery **and** the diagnostics gate
complete, and only one task may be active at a time. Check that no other
instance holds the lock and that the active task is not stuck in a
preflight/ready state (see 4.1).

## 5. Cache and disk

### 5.1 Cache root not writable (cache_not_writable)

The resolved cache root (`HF_HOME` / `HF_HUB_CACHE` / `HF_XET_CACHE` paths)
is not writable. Make the directory writable, or configure cache path
overrides in Settings.

### 5.2 Low free space

The Diagnostics page estimates free space for destination drives. Free space
before starting large transfers; interrupted large transfers leave partial
cache data that is reused by retries.

### 5.3 Symlink degradation

Windows symlink support varies by file system and policy. If the cache layout
or a clone behaves unexpectedly, check the symlink diagnostic; some setups
fall back to copying instead of linking.

## 6. Credentials

### 6.1 keyring_rejected banner

The active keyring backend is not the Windows Credential Manager
implementation (for example a null/fail/plaintext/chainer backend or a
`keyrings.alt` module). HubFetch **fails closed**: manual tokens cannot be
stored until the backend is the Windows Credential Manager. Reset keyring to
the Windows backend or fix the keyring configuration; anonymous access and
shared browser OAuth remain usable.

### 6.2 "credential backend unavailable" from AskPass

The AskPass helper could not construct the Windows Credential Manager store,
or the alias has no stored token. Re-add the token in Settings (it will get a
fresh opaque alias) and retry the clone.

### 6.3 I forgot where tokens are stored

Manual tokens live in Windows Credential Manager under the service name
`HubFetch.Credentials`, referenced by opaque `hfc-` aliases. Delete the alias
there or in the app to remove a token. The shared OAuth token lives in the
Hub's own shared storage, not in HubFetch.

## 7. Support bundle

If you need help, export a support bundle from Diagnostics and hand the ZIP
to a maintainer. The bundle contains only sanitized versions, settings,
diagnostics, and allowlisted `.jsonl`/`.log` logs. It never contains the
database, credentials, environment dumps, screenshots, or cache files, and
its export **fails closed** if a registered secret would survive.

## 8. Uninstall and cleanup

- Delete the extracted `HubFetch` directory to uninstall (no installer).
- Application data (`hubfetch.db`, cache, logs) lives in the user data
  directory and is not removed automatically; delete it manually for a full
  cleanup (Diagnostics shows the resolved paths).
- Remove any `HubFetch.Credentials` entries in Windows Credential Manager to
  erase stored tokens.
- No environment variables are left behind; HubFetch never modifies the
  global environment.
