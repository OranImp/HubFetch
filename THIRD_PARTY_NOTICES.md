# HubFetch Third-Party Notices

HubFetch 0.2.0 is distributed under the Apache-2.0 license; the full project license ships in this
repository as `LICENSE`.

This document lists the third-party software distributed with HubFetch and the licenses that apply
to each component. It also records the direct reuse of the HubFetch brand icon from the archived
pre-cutover project.

The dependency inventory is generated from the workspace production `dependencies` declared in
`package.json`, `apps/desktop/package.json`, `packages/shared/package.json`, and
`packages/hub-api/package.json`, reconciled against the installed `node_modules` license metadata.
The generator and its check mode live in `scripts/notices.test.mjs` (see `pnpm test:docs`).

## Direct third-party dependencies

| Package                | Version (installed) | License | Homepage                                      |
| ---------------------- | ------------------- | ------- | --------------------------------------------- |
| better-sqlite3         | 12.x                | MIT     | https://github.com/WiseLibs/better-sqlite3    |
| hyparquet              | 1.x                 | MIT     | https://github.com/hyparam/hyparquet          |
| ignore                 | 5.x                 | MIT     | https://github.com/kaelzhang/node-ignore      |
| zod                    | 4.x                 | MIT     | https://github.com/colinhacks/zod             |
| @huggingface/hub       | 2.x                 | MIT     | https://github.com/huggingface/huggingface.js |
| @huggingface/inference | 4.x                 | MIT     | https://github.com/huggingface/huggingface.js |

All direct third-party dependencies are MIT-licensed. The exact installed versions are governed by
`pnpm-lock.yaml`; the notices generator in `scripts/notices.test.mjs` verifies that every production
dependency is present in this table and that its declared license matches the installed metadata.

## Transitive runtime dependencies

Transitive runtime dependencies (for example the `@huggingface/tasks` and `@huggingface/jinja`
packages pulled in by `@huggingface/hub`/`@huggingface/inference`, and the SQLite amalgamation
bundled by `better-sqlite3`) are MIT-licensed. The full, exhaustive inventory of every package in
the dependency tree (including development-only tooling) is available from:

```sh
corepack pnpm licenses list
```

## Reused brand asset

The application icon (`apps/desktop/build/icon.png`, `icon.ico`) is **HubFetch's own brand asset**,
restored from the archived HubFetch 0.1.0 project. It is not a third-party icon. The applicable MIT
notice is recorded in `apps/desktop/build/ICON-NOTICE.md`:

> Origin: owner-authored HubFetch icon (the PySide HubFetch 0.1.0 project). License: MIT — the
> archive is distributed under the MIT License, "Copyright (c) 2026 HubFetch".

## Apache-2.0 source attribution

HubFetch is an independent fork of the Apache-2.0 upstream
[Oh My HuggingFace](https://github.com/fzlzjerry/ohmyhf) (`v0.0.9`). Source provenance, the
modification summary, and the archive references are documented in
[`UPSTREAM_SOURCE.md`](UPSTREAM_SOURCE.md). Neither HubFetch nor the upstream project is affiliated
with or endorsed by Hugging Face, Inc.
