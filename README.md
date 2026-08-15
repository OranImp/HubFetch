# HubFetch

HubFetch is a Windows 11 x64 desktop application for managing local Hugging
Face download and Git clone workflows. It runs a one-task-at-a-time transfer
queue, downloads individual files and filtered snapshots through a pinned
`huggingface_hub` adapter, performs real Git working-copy clones through
system Git, and ships as an unsigned portable ZIP with no installer and no
update mechanism.

HubFetch is an independent project and is not affiliated with or endorsed by
Hugging Face, Inc.

## What HubFetch does

- **Downloads** — single-file and filtered/full snapshot downloads for model,
  dataset, and Space repositories at a branch, tag, or full commit revision,
  with dry-run estimates, include/exclude patterns, automatic Hub cache
  resume, and three destination conflict policies.
- **Clones** — real Git working-copy clones through system Git and system
  Git-Xet into an empty or new destination, with forced progress capture,
  dependency/version diagnostics, and Git Credential Manager / SSH preference
  with an app-token AskPass fallback.
- **Queue** — one global FIFO scheduler; exactly one task runs at a time, the
  next queued task starts automatically, and interrupted work is recovered at
  startup.
- **Cancellation, retry, recovery** — queued tasks cancel without a worker,
  active tasks receive a cooperative stop and then a bounded process-tree
  termination, terminal tasks can be retried as fresh linked attempts, and
  abandoned `running`/`cancelling` tasks become `interrupted` at startup.
- **Authentication** — anonymous access, shared machine browser OAuth behind
  one pinned compatibility adapter, or HubFetch-only manual tokens stored in
  Windows Credential Manager behind opaque aliases.
- **Proxies** — per-task system inheritance, an explicit direct mode, or a
  validated manual HTTP/HTTPS proxy (seeded with `http://127.0.0.1:7897`).
- **Diagnostics** — cache/disk/dependency checks, Windows symlink awareness,
  Git/Git-Xet and credential-helper readiness, endpoint reachability, and
  sanitized support-bundle ZIP export.
- **Languages** — Simplified Chinese as the default locale with a complete
  English catalog from the first release.

## Release facts

| Item | Value |
|---|---|
| Version | 0.1.0 |
| Platform | Windows 11 x64 (build >= 22000, AMD64) |
| Runtime | Python 3.12 (`>=3.12,<3.13`) |
| GUI | PySide6 6.11.1 |
| Hub library | huggingface_hub 1.27.0 |
| Packaging | PyInstaller 6.22.0, one-folder COLLECT, no UPX, no one-file |
| Identifiers | `HubFetch.Desktop`, `HubFetch.Credentials`, `hubfetch.db` |
| License | MIT (see `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/qt-lgpl-compliance.md`) |
| Delivery | Unsigned portable ZIP `artifacts/HubFetch-0.1.0-windows-x64.zip` |
| Updates | None — no update check, no release polling, no self-update |

## What HubFetch does NOT do

HubFetch does not provide upload, repository create/delete/move/settings/tag
or branch mutation, or any other remote-write feature. It ships no MSIX
package, no installer, no signing or elevation, and no background updater. It
bundles no Git, Git-Xet, or Hugging Face command-line tool; Git and Git-Xet
must be installed separately. Git clones are never resumed in place; a
retried clone requires an empty or new destination. Manual tokens are never
accepted or recommended through environment variables (`HF_TOKEN` and the
other credential-bearing variables are stripped from every worker
environment). There is no official Hugging Face affiliation or endorsement,
and the package is not a trusted-signing release.

## Prerequisites

- Windows 11 x64 (build >= 22000)
- Python 3.12 (only for development and building; the packaged archive needs
  no installed Python)
- `uv` (development and building)
- Git (runtime, for clone tasks)
- Git-Xet (runtime, for repositories that use Xet storage; download-only
  tasks do not require it)

Install Git and Git-Xet as an unprivileged user; neither requires elevation.
Git for Windows installs credential helper support through Git Credential
Manager. See [docs/user-guide.zh-CN.md](docs/user-guide.zh-CN.md) or
[docs/user-guide.en.md](docs/user-guide.en.md) for exact `winget` commands and
the non-elevated guidance.

## Quick start (user)

1. Extract the portable ZIP into a folder (a path with spaces or non-ASCII
   characters is fine).
2. Start `HubFetch.exe`. Windows will show a SmartScreen warning because the
   archive is unsigned; read it, choose "More info / Run anyway" only if you
   trust the source of the archive.
3. Use **Download** to fetch files or snapshots and **Clone** to create a Git
   working copy, then watch the queue in **Tasks**.
4. See **Diagnostics** for cache/disk/Git/credential health and to export a
   support bundle.

Read the full user guide: [简体中文](docs/user-guide.zh-CN.md) /
[English](docs/user-guide.en.md).

## Documentation

- [User guide (简体中文)](docs/user-guide.zh-CN.md) — primary documentation
- [User guide (English)](docs/user-guide.en.md) — paired translation
- [Architecture](docs/architecture.md) — maintainer documentation
- [Security model](docs/security.md) — credential boundaries and redaction
- [Troubleshooting](docs/troubleshooting.md) — diagnostics and common issues
- [Releasing](docs/releasing.md) — reproducible release procedure
- [Contributing](docs/contributing.md) — development workflow and gates
- [Qt LGPL compliance](docs/qt-lgpl-compliance.md) — dynamic Qt licensing
- [Design system](DESIGN.md) — Transfer Ledger design tokens and rules
- [Changelog](CHANGELOG.md)

## Development

```powershell
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run basedpyright
uv run pytest -q
uv run python scripts/check_no_excuse_rules.py .
```

Run all quality gates at once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_quality_gates.ps1
```

Check the design contract and package policy:

```powershell
uv run python scripts/check_design_contract.py
uv run python scripts/check_package_policy.py packaging\hubfetch.spec --json .omo\evidence\package-policy.json
uv run python scripts/generate_notices.py --check
```

## Building the portable archive

From a clean shell on Windows 11 x64:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1 -Frozen -EvidenceDir .omo\evidence\task-30-windows-huggingface-manager
powershell -ExecutionPolicy Bypass -File scripts\smoke_portable.ps1 -Zip artifacts\HubFetch-0.1.0-windows-x64.zip -EvidenceDir .omo\evidence\task-30-windows-huggingface-manager\smoke
```

The build asserts the platform, the exact Python 3.12 and pinned dependency
versions, the clean frozen lock, every mandatory quality gate, translation
compilation, license notices, and the package policy before producing
`artifacts/HubFetch-0.1.0-windows-x64.zip`. The smoke script extracts the ZIP
into a clean path with spaces and non-ASCII characters, removes the project,
venv, and Python from `PATH`, and runs the packaged `--smoke-test` plus a GUI
capture with an isolated app-data root. See [docs/releasing.md](docs/releasing.md).

## License

HubFetch is distributed under the MIT license (see `LICENSE`). Third-party
component licenses are listed in `THIRD_PARTY_NOTICES.md`; Qt/PySide6
compliance is documented in `docs/qt-lgpl-compliance.md`. The bundled
Cascadia Mono font is under the SIL Open Font License 1.1 (`resources/fonts/OFL.txt`).
