# HubFetch Contributing

Development workflow, comment standard, and quality gates for the HubFetch
repository. Read [architecture.md](architecture.md) for the component layout
and [security.md](security.md) for the security boundaries before editing.

## 1. Getting started

Prerequisites: Windows 11 x64, Python 3.12, `uv`, Git, Git-Xet.

```powershell
uv sync --frozen
```

The environment is locked: use `uv sync --frozen` (never a bare `uv sync`
that could silently update `uv.lock`). Activate nothing by hand; run tools
through `uv run`.

## 2. Mandatory quality gates

Every change passes all of these before commit (all must exit 0):

```powershell
uv run ruff format --check .
uv run ruff check .
uv run basedpyright
uv run pytest -q
uv run python scripts/check_no_excuse_rules.py .
```

`basedpyright`'s accepted gate is **0 type errors**: like the build script
(`scripts\build_windows.ps1`'s `Invoke-Basepyright`), the committed
configuration reports pre-existing warnings (220) and may exit nonzero in
captured output even when the error count is zero; the summary line `0
errors, ...` is the pass criterion.

Or run them all at once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run_quality_gates.ps1
```

Focused gates per concern:

```powershell
uv run pytest -q tests/docs/test_documentation_contracts.py   # documentation contracts
uv run python scripts/check_design_contract.py                 # DESIGN.md contract
uv run python scripts/check_package_policy.py packaging\hubfetch.spec --json .omo\evidence\package-policy.json
uv run python scripts/generate_notices.py --check               # third-party notices
uv run python scripts/check_no_excuse_rules.py .                # anti-slop / module size
```

## 3. Strict typing rules

- `basedpyright` runs with `typeCheckingMode = "all"` on Python 3.12 /
  Windows platform. No `Any`, `cast`, `# type: ignore`, or
  `# pyright: ignore` outside the three documented scoped exceptions in
  `hub/adapter.py` (a third-party stub defect, pinned and justified in that
  module's docstring).
- Branded `NewType` primitives for every distinct semantic unit (`TaskId`,
  `AttemptId`, `RepositoryId`, `CredentialAlias`, `HttpUrl`).
- Boundary parsing with Pydantic v2 (`frozen=True`, `extra="forbid"`); the
  interior receives typed values and never re-validates.
- Enum/tag discrimination is exhaustive `match` + `assert_never`, never
  `if/elif` chains.
- No broad `except Exception` outside a documented top-level boundary.

## 4. Module and function discipline

- Keep source modules under 250 pure LOC; if a module must be larger, add a
  specific `# noqa: SIZE_OK` justification naming why it cannot split (see
  `application/runtime.py` and `diagnostics/support_bundle.py` for the
  accepted pattern).
- No function with more than 3 parameters; group related parameters into a
  typed value object.
- No redundant verification after a destructive action; trust the operation's
  contract.
- No negative-form names where a positive name works (`isValid`, not
  `isNotValid`).
- Never perform a delete/remove and then re-query to "confirm" it worked.

## 5. Comment standard

- Comments explain **why / contract / risk**, never narrate obvious
  assignments or control flow.
- Required rationale comments exist for: the explicit lifecycle transition
  table, Win32 Job/IPC ordering, credential boundaries, startup recovery,
  cancellation escalation ordering, the redaction serialization boundary, and
  non-obvious invariants.
- Module and public API docstrings use Google style (the ruff pydocstyle
  convention is `google`). When you touch IPC, Job objects, credentials, or
  redaction, read the existing rationale comments in the neighboring modules
  and keep the standard consistent.

## 6. Testing discipline

- Focused TDD: every behavior change starts with a failing test
  (red → green → refactor), structured Given / When / Then with one
  observable `When` per test.
- Use real temporary SQLite/filesystem/processes and narrow wire-level fakes;
  no sleeps as synchronization, no mock-everything tests, no prose
  snapshots.
- Windows-only behavior is marked `@pytest.mark.windows` (skipped off
  Windows). A change that touches Win32, Job Objects, or QProcess must run
  its focused tests on Windows 11 x64.
- Security tests use the sentinel `hf_test_secret_123` and assert byte
  absence from every sink (SQLite/WAL, logs, events, support ZIP, argv,
  environment snapshots, screenshots, package files).
- Documentation changes run `tests/docs/test_documentation_contracts.py`,
  which verifies identifiers, pinned versions, referenced scripts, supported
  features, both languages, required security/cancellation/retry/license
  clauses, valid local links, and the absence of banned claims.

## 7. Committing

- English Conventional Commits, one per concern: `feat`, `fix`, `refactor`,
  `test`, `docs`, `build`, `chore` (scope when useful, e.g.
  `docs(project): document HubFetch operation and release`).
- Before committing, inspect `git status --short`, `git diff --cached
  --check`, and `git diff --cached --stat`. Stage only intended files.
- Never stage `.venv/`, `build/`, `dist/`, `artifacts/`, `package/`,
  `.omo/` (including evidence), local databases/logs/cache, generated `.qm`
  files, or unrelated user changes.
- Do not use `--no-verify`; do not add a git remote or perform GitHub
  operations.

## 8. Dependency update procedure

Because `0.x` minors are treated as breaking and the lock is frozen, any
dependency change follows a strict review path:

1. Verify the runtime pins in `pyproject.toml` (`PySide6==6.11.1`,
   `huggingface_hub==1.27.0`, `PyInstaller==6.22.0`, `keyring>=25.6,<26`,
   `pydantic>=2.12,<3`, `requires-python >=3.12,<3.13`) are intentional.
2. Update the manifest, then run `uv lock` and commit the regenerated
   `uv.lock` **together** with the manifest change. Never hand-merge a
   lockfile.
3. Read the changelog of the target (`0.x` minor = major: expect breaking
   changes) and re-run every gate plus the focused tests of the affected
   component(s).
4. Regenerate `THIRD_PARTY_NOTICES.md` (`scripts\generate_notices.py`),
   update `docs/qt-lgpl-compliance.md` if a Qt/PySide6 version changed, and
   update this documentation wherever a version string is pinned.
5. Rebuild and smoke the archive, and confirm the new pins still satisfy the
   tests in `tests/docs/test_documentation_contracts.py`.

## 9. Scope guardrails

- No upload, repository create/delete/move/settings/tag/branch mutation, or
  other remote-write feature; no disabled placeholder UI implying them.
- No MSIX/App Installer/Store submission, certificate generation, elevation,
  installer service, trusted-publisher claim, release API polling, version
  check, background updater, artifact auto-download, or self-update — none of
  these exist in the product.
- No GitHub OAuth/PAT storage, GitHub API client, `gh repo create`, or
  `origin` remote.
- No bundled Git, Git-Xet, `hf` CLI dependency, static Qt link, one-file
  freezer mode, UPX, or GPL-only Qt module.
- No token in source, config, SQLite, task/event payloads, logs, support
  bundles, crash text, URLs, process arguments, inherited worker environment,
  screenshots, or test artifacts. No plaintext keyring fallback, no
  `keyrings.alt`.
- Do not claim official Hugging Face affiliation, trusted signing, Git clone
  resume, secret-free support bundles without tests, or features absent from
  the application.
