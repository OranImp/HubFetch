# HubFetch Releasing

Reproducible release procedure for HubFetch 0.1.0 (and later versions).
Architecture and dependency rules: [architecture.md](architecture.md).
Quality gates: [contributing.md](contributing.md).

## 1. Reproducibility principles

- **Frozen lock**: all builds run `uv sync --frozen`; `uv.lock` is committed
  and never silently updated. CI/build never runs a bare `uv sync`.
- **Exact toolchain**: the build asserts Windows 11 x64/AMD64, Python 3.12,
  `PySide6 6.11.1`, `huggingface_hub 1.27.0`, and `PyInstaller 6.22.0`, and
  fails on any mismatch.
- **Deterministic archive**: the ZIP uses a fixed top-level `HubFetch`
  directory layout; third-party notices and the manifest are generated
  deterministically from `uv.lock`; `.qm` files are compiled from committed
  `.ts` sources.
- **No environment dependence**: the portable smoke runs with a cleaned
  `PATH` (no project, venv, or Python) and an isolated app-data root, proving
  the archive needs no installed Python.

## 2. Release checklist

Run every step from a clean shell at the repository root on Windows 11 x64
(build >= 22000).

### 2.1 Quality gates (must all exit 0)

```powershell
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run basedpyright
uv run pytest -q
uv run python scripts/check_no_excuse_rules.py .
```

`basedpyright` must exit **0** with a clean summary (`0 errors, 0 warnings`).
The repository ships no warning set: `reportUnusedCallResult` is disabled in
`pyproject.toml` because PySide6's idiomatic API returns are conventionally
ignored. Any nonzero exit from `basedpyright` fails the release.

Or run them all at once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_quality_gates.ps1
```

### 2.2 Documentation and design contracts

```powershell
uv run pytest -q tests/docs/test_documentation_contracts.py
uv run python scripts/check_design_contract.py
```

### 2.3 License notices and package policy

```powershell
uv run python scripts/generate_notices.py --check
uv run python scripts/check_package_policy.py packaging\hubfetch.spec --json .omo\evidence\package-policy.json
```

`generate_notices.py --check` verifies the committed `THIRD_PARTY_NOTICES.md`;
the package policy rejects UPX, one-file mode, bundled Git/Git-Xet/hf
binaries, database paths inside the package, missing replaceable Qt
resources, and GPL-only Qt modules.

### 2.4 Build the portable archive

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build_windows.ps1 -Frozen -EvidenceDir .omo\evidence\task-30-windows-huggingface-manager
```

The script produces `artifacts\HubFetch-0.1.0-windows-x64.zip` (version read
from `pyproject.toml`) and appends a transcript to `build.txt` in the
evidence directory.

### 2.5 Smoke the archive

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke_portable.ps1 -Zip artifacts\HubFetch-0.1.0-windows-x64.zip -EvidenceDir .omo\evidence\task-30-windows-huggingface-manager\smoke
```

The smoke script:

1. Extracts the ZIP into a clean temp path that contains spaces and non-ASCII
   characters.
2. Removes `PYTHONPATH`, `PYTHONHOME`, `VIRTUAL_ENV`, `CONDA_PREFIX`,
   `HUBFETCH_APP_DATA_ROOT`, and the inherited credential/AskPass variables,
   and reduces `PATH` to Windows system directories (no Python, no project,
   no venv, no package manager).
3. Checks the PE architecture of both entry points (`HubFetch.exe` and
   `HubFetchAskPass.exe` are AMD64).
4. Verifies the required license/plugin/DLL inventory and rejects forbidden
   binaries (git.exe, git-lfs.exe, git-xet, hf.exe, hub.exe) and database
   files.
5. Scans every packaged file for the sentinel `hf_test_secret_123`.
6. Runs `HubFetch.exe --smoke-test --app-data-root <isolated>` with a
   machine-readable report (frozen, AMD64, settings roundtrip, package
   inventory, AskPass credential cycle, zero errors).
7. Captures the empty Tasks shell offscreen to `empty-shell.png`.
8. Confirms zero orphan HubFetch processes and cleans up.

Any contract failure writes `package-failures.txt` and exits nonzero.

## 3. Versioning and changelog

- The version is the single source of truth in `pyproject.toml`
  (`version = "0.1.0"`); the build script reads it for the ZIP name.
- Update `CHANGELOG.md` for every release under the new version heading,
  using the existing `[Unreleased]` / version structure. Keep the "Added /
  Changed / Fixed / Removed / Security" grouping.
- Release commits are English Conventional Commits (e.g.
  `docs(project): document HubFetch operation and release`). One commit per
  concern; do not squash earlier completed work unless the user explicitly
  requests history rewriting.
- `git remote` stays empty; there is no `origin`, no GitHub API, no release
  polling, and no self-update. Distributing the ZIP is a manual step.

## 4. Post-release verification

Before declaring a release complete, confirm:

- `git status --short` shows no unintended dirty/untracked product files.
- `git log --oneline -1` names the expected release commit.
- The evidence directory contains `build.txt`, `portable-smoke.json`,
  `smoke-result.json`, and `empty-shell.png`.
- `docs-report.json` (from the documentation contract run) shows all
  clauses present and no violations.
