# Upstream Sync

HubFetch is an independent fork of the upstream
[Oh My HuggingFace](https://github.com/fzlzjerry/ohmyhf) desktop client. The upstream remote is kept
**read-only**; HubFetch never pushes to it. This document describes how upstream changes are
tracked and, when appropriate, merged.

## Read-only upstream workflow

- Upstream remote: `https://github.com/fzlzjerry/ohmyhf.git` (Apache-2.0), imported as an untouched
  `v0.0.9` snapshot at the cutover commit. Full provenance is in
  [`UPSTREAM_SOURCE.md`](../UPSTREAM_SOURCE.md).
- The upstream remote is used only to **fetch**; no HubFetch branch is ever pushed there.

## Tracking upstream

To see whether upstream has moved since the imported snapshot:

```sh
git fetch upstream
git log --oneline upstream/main
```

The snapshot is pinned to the upstream `v0.0.9` commit
`3bdf5d6027395bb2bbdd611930012712edf8d7b0`. Any upstream commit after that is a candidate to review.

## When to merge upstream

HubFetch has diverged substantially from upstream (identity, delivery, proxy, diagnostics, native
clone bridge, clone product integration). Most upstream changes are therefore **not** applicable
verbatim. Before merging any upstream change:

1. Review the upstream diff and note which HubFetch subsystems it touches.
2. Prefer **cherry-picking** a specific upstream commit over a full merge when the change is small
   and isolated.
3. For any upstream change that conflicts with HubFetch's own work (packaging, updater removal,
   proxy, native clone), port the _intent_ by hand rather than merging blindly.

## What to keep

- The Apache-2.0 license and upstream attribution (see `LICENSE` and `UPSTREAM_SOURCE.md`).
- Upstream bug fixes for shared behavior (Hub API client, UI) that HubFetch has not intentionally
  diverged from.

## What to never reintroduce

When syncing upstream, do **not** bring back behavior that HubFetch intentionally removed or
changed:

- self-updater / release-feed metadata;
- multi-platform packaging targets or installers (HubFetch ships only an unsigned Windows x64 ZIP);
- the old PySide6/Python/PyInstaller runtime (retained only in the `archive/pyside-hubfetch-0.1.0`
  refs);
- the legacy global FIFO or Windows Credential Manager auth model (HubFetch uses safeStorage +
  Job-bound AskPass).

## After a sync

- Run the full gate suite (`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the
  policy tests `pnpm test:docs` / `pnpm test:no-updater` / `pnpm test:privileges` /
  `pnpm test:release-tools`).
- Update `UPSTREAM_SOURCE.md` and `docs/changelog.md` with the synced upstream commit and a summary
  of what was adopted.
