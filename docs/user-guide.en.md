# HubFetch User Guide (English)

HubFetch is an unofficial, community-built Windows desktop client for the Hugging Face Hub. It is
**not affiliated with or endorsed by Hugging Face, Inc.**

This guide walks through installing, signing in, downloading, cloning, and configuring HubFetch.

## Overview

HubFetch lets you browse the Hugging Face Hub, download models and datasets into the standard HF
cache, clone repositories into working copies with real Git, and manage your Hub workflow from one
application. It is privacy-first: there is no telemetry, and your token is encrypted at rest.

## Installing

1. Download `HubFetch-<version>-windows-x64.zip` from
   [GitHub Releases](https://github.com/OranImp/HubFetch/releases).
2. Extract the ZIP to a folder of your choice.
3. Run `HubFetch.exe`.

The ZIP is **unsigned**. Windows SmartScreen may show a warning on first launch; choose
**More info → Run anyway** and verify the ZIP against its published SHA-256 checksum. There is no
installer and no auto-updater — to update, download a newer build and replace the files.

Requirements: Windows x64. For the clone feature, **Git** (and **Git-Xet** for Xet-backed repos)
must be installed and on `PATH`. HubFetch does **not** bundle these tools; open **Settings → Clone
tools** to check readiness and reach their official download pages when something is missing.

## Signing in

Open **Settings → Account** and paste a
[User Access Token](https://huggingface.co/settings/tokens). Prefer a **write** token (or a
fine-grained token with the permissions you need) so gated downloads, discussions, collections, and
Hub notifications all work. The token is encrypted with your OS keychain and stored at
`%APPDATA%\HubFetch\credentials.json`; it is never stored in plaintext or in `localStorage`.

You can also capture a Hub web session through the app, which enables cookie-backed social features
(posts, reactions, and other write actions).

## Browsing

- The **Browse** pages show Models, Datasets, Spaces, and Daily Papers in a three-pane layout.
- Press `Cmd/Ctrl+K` to open the command palette to search, filter, and sort.
- Click a repo to see its model card, file tree, metadata, and discussion.
- Use **Compare** to view 2–4 models side by side.

## Space administration

If you own a Space (or collaborate on it) and sign in with a token that includes repository
administration rights, the Space detail page offers an operations panel:

- **Runtime status** shows the lifecycle stage (running, building, paused, sleeping, stopped,
  errors), the current hardware flavor, a pending hardware switch ("Requested hardware"), and the
  sleep window — only when the Hub reports one. A free-tier `cpu-basic` Space without a reported
  window shows "Hub-managed automatic sleep"; the app never guesses a duration.
- **Pause** stops the app and releases its hardware (files and settings are kept). Pausing asks
  for confirmation. **Resume** brings a paused Space back through a normal restart.
- **Restart** rebuilds and restarts the app; **Factory rebuild** also clears the build cache and
  requires typing the exact repository id to confirm.
- **Hardware** can be switched from the public catalog. Selecting an upgraded flavor asks for
  typed confirmation of the repository id and warns that billing may start immediately — the app
  deliberately shows no prices or cost estimates; check the Hub website for actual pricing.
- **Sleep time** sets how long an idle upgraded-hardware Space stays awake before sleeping; you
  can also choose "never sleep" where the Hub accepts it. The control is disabled where the Hub
  manages sleep automatically.
- **Secrets** (write-only values), **variables**, and **build/run logs** behave as before and are
  unaffected by lifecycle actions.

Space volumes, dev mode, SSH, and metrics management are intentionally not part of the app.

## Downloading

- Open a repo and start a download, or use the download manager to queue and schedule transfers.
- Downloads are **parallel and resumable**, support **speed limiting**, and verify files with
  **SHA-256**.
- Files land in the **standard HF cache layout**, so they interoperate with `transformers`,
  `hf`, and other tooling.
- Downloads and clones are independent subsystems with separate concurrency; pausing or cancelling
  a download does not affect clone tasks.

## Cloning

HubFetch clones repositories into a real Git working copy through **system Git** (and **system
Git-Xet** when the repo uses Xet filters).

- Clones run **one at a time** under a durable scheduler.
- You can clone a branch, tag, or full commit; progress is shown and work is **recovered on
  restart**.
- **Prerequisites**: before your first clone, open **Settings → Clone tools** and check the Git,
  Git-Xet, and Git Credential Manager rows. Missing tools link to their official download pages;
  after installing, press **Recheck** — restart HubFetch if a tool is still reported missing.
- **Authentication**: Git clones authenticate through system Git (Git Credential Manager / SSH) or,
  for app-token clones, through a secure Job-bound AskPass helper. The helper never writes the token
  to disk.
- If Git or Git-Xet is missing, the Diagnostics page reports readiness so you can fix it first.

## Proxies

Network settings offer three closed modes:

- **System** — inherit the OS proxy configuration (default).
- **Direct** — bypass environment, Chromium, and Git-config proxies.
- **Manual** — use a specific HTTP/HTTPS proxy URL.

The choice applies to both Hub API traffic and Git clone child processes. See
[architecture.md](architecture.md#proxy-semantics) for details.

## Diagnostics & support bundle

Open the **Diagnostics** page to see cache/disk health, Git and Git-Xet readiness, credential-helper
and SSH availability, endpoint reachability, and proxy status.

Use **Export support bundle** to produce a sanitized ZIP of redacted logs and structured state for
sharing in bug reports. Secrets are redacted centrally; the export fails closed if any registered
secret leaks in.

## Notifications

HubFetch can show system notifications for completed transfers and for follows/inbox and Daily
Papers updates. Enable or disable them under **Settings**. Notifications are fully local; nothing is
sent to any third party.

## Settings

From **Settings** you can manage: language (nine locales), theme (system/light/dark), download
concurrency and speed limits, notifications, polling interval, UI scale and density, accent color,
cache directory, the Hub endpoint, proxy, launch at login, close-to-tray, and per-repo open target.

**Clone tools** (under Connection) shows Git, Git-Xet, and Git Credential Manager readiness with
links to their official download pages. Use **Recheck** after installing and restart HubFetch if a
tool is still reported missing.

You can **export** and **import** your settings (excluding the machine-specific cache directory) to
move them between machines.

## Privacy & data

- Your token and Hub web session are encrypted at rest and never logged.
- Browsing history, favorites, follows, download tasks, and clone state are stored locally in
  SQLite.
- **Clear local data** (favorites, history, downloads, follows, inbox) and sign out are available
  under Settings; you can also delete the credentials file to sign out everywhere.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md) for common issues: SmartScreen warnings, Git/Git-Xet
not found, proxy connection failures, and how to gather a support bundle.
