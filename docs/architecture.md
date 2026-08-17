# Architecture

HubFetch is an Electron desktop application for Windows x64 that browses and manages the Hugging
Face Hub. This document describes the runtime architecture, the IPC contract, the native clone
bridge, and the network (proxy) semantics.

## Process model

```
packages/shared     @hubfetch/shared    shared types + typed IPC contract (no Electron deps)
packages/hub-api    @hubfetch/hub-api   pure-TS Hub API client (zero Electron deps)
apps/desktop        hubfetch-desktop    electron-vite app (main / preload / renderer)
```

- **Main process** (`apps/desktop/src/main`): owns all network I/O, the download manager, the clone
  scheduler, cache scanning, polling, the native bridge, and IPC. Heavy work runs in
  `worker_threads` off the main thread.
- **Renderer** (`apps/desktop/src/renderer`): view-only React (React Router, Zustand, TanStack
  Query/Virtual, Tailwind, Radix). Hardened with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, and a strict CSP. The renderer never touches
  Node.js APIs directly.
- **Preload**: exposes a narrow, typed surface (`window.hubfetch.*`) built from the shared IPC
  contract.

## Typed IPC contract

The entire IPC surface is a **typed contract** in `packages/shared`. There are no magic string
channels: invoke channels, event channels, requests, and responses are all declared as types, and
every handler validates its payload with zod before doing any work. The preload exposes only these
channels, and a sender-trust guard rejects calls from unexpected origins.

## Local storage

- **SQLite** (`better-sqlite3`) stores favorites, history, download tasks, follows, clone state,
  and settings in the app data directory.
- **Credentials** (`%APPDATA%\HubFetch\credentials.json`) are a separate file, encrypted with the
  OS keychain (Electron `safeStorage`), atomically written with a current-user-only DACL, and
  **never** stored in SQLite or `localStorage`.

## Download subsystem

The download manager is a **parallel, resumable queue** with speed limiting and SHA-256
verification. It writes into the **standard HF cache layout** so the cache is interoperable with
`transformers`, `huggingface-cli`, and friends. Downloads have their own concurrency and are
independent of the clone subsystem.

## Clone subsystem

Clones are **separate** from downloads: they run one task at a time under a **durable scheduler**
with progress capture, cancellation, and restart recovery. Clone state persists in SQLite so an
interrupted task is recovered on the next launch.

- **Native bridge**: a native Windows addon (`hubfetch_job.node`) creates a **Job Object** that
  contains every child process in a clone tree, so cancellation and app shutdown can terminate the
  whole tree without orphans.
- **Utility-process handshake**: clone child processes (git, git-xet) run as contained utility
  processes inside the Job.
- **AskPass**: app-token clones authenticate through a **Job-bound AskPass helper**
  (`HubFetchAskPass.exe`). The helper verifies the requesting PID belongs to the app's Job and never
  writes the token to disk.
- **Readiness**: the Diagnostics page reports Git and Git-Xet versions/readiness so clone failures
  are diagnosable before work starts.

## Proxy semantics

Network settings expose three closed proxy modes that apply to both Hub API traffic and Git child
processes:

- **System** — inherit the OS-level proxy configuration. Git child processes inherit the parent
  environment unchanged.
- **Direct** — bypass environment, Chromium, and Git-config proxies. For Git, the child receives
  `-c http.proxy= -c https.proxy=` and an environment with proxy variables stripped. The parent
  environment is never mutated.
- **Manual** — use a specific validated HTTP/HTTPS proxy URL. For Git, the child receives
  `-c http.proxy=<url> -c https.proxy=<url>`.

The global Git configuration is **never mutated**; proxy selection is passed per-command. Each
download/clone task snapshots the proxy selection at creation time so a later settings change does
not silently retarget an in-flight transfer.

## Security boundaries

- Renderer is sandboxed; all privileged work stays in main.
- IPC validates every payload; sender-trust is enforced.
- Tokens never leave the main process over HTTP to non-Hub hosts, and are redacted from logs and
  support bundles.

See [security.md](security.md) for the full threat model.
