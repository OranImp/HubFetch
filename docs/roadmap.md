# Roadmap

This document maps what HubFetch delivers today, how it is maintained, and where it is heading.
It is a living map of the **current development tree** — nothing here labels a future version as
released. Version history lives in [changelog.md](changelog.md); release mechanics in
[releasing.md](releasing.md).

## What HubFetch is

An unofficial, community-built **Windows x64** desktop client for the Hugging Face Hub, built as an
Electron app with a strict local-first posture: no telemetry, no account-less network calls, no
cloud component of its own. The app ships as an unsigned ZIP with manual updates; see
[security.md](security.md) for the token/session model and [releasing.md](releasing.md) for how
artifacts are verified.

## Delivered capability map

The roadmap plan (21 implementation tasks) has been implemented on this tree. Components, grouped
by subsystem:

### Maintenance baseline

- **Product identity** — all four workspace manifests and the docs describe one version (0.3.0);
  current-product docs removed the deprecated `huggingface-cli` wording in favor of the `hf` CLI;
  policy tests reject current-doc drift (`scripts/docs-contract.test.mjs`).
- **i18n tooling** — extraction via `i18next-cli` with explicit dynamic-key preservation; CI runs
  `i18n:check`; nine locales are parity-gated by `locales.test.ts`.
- **Hub client behavior baseline** — a capability registry labels every public `HubClient` method
  with a stability class (below), and transport invariants are locked by local fixture tests
  (auth-host allowlist, retry/cache/stale policy, credential stripping on redirects, request
  scheduling).
- **Secret scanning** — pinned Gitleaks workflow over full history with read-only permissions and a
  narrow allowlist (`.gitleaks.toml`).
- **Supply chain** — `corepack pnpm release:sbom` emits a CycloneDX 1.7 SBOM; a verifier enforces
  workspace components, dependency edges, and licenses without extra SBOM dependencies; release
  preflight accepts exactly one ZIP + SHA-256 + SBOM.
- **Visual & scheduled stability** — deterministic Playwright screenshot baselines with an approval
  gate, plus a scheduled weekly Windows stability run (full verification, native rebuild tests,
  packaged smoke).

### Hub API client architecture

- **Transport core** (`packages/hub-api/src/core/`) — normalized endpoint/auth-host policy, request
  construction with body caps, concurrency/gap scheduling, retry with `Retry-After`, and a GET
  cache with in-flight coalescing and stale-on-transient-failure. Only the transport attaches
  credentials; token auth never reaches non-Hub hosts and redirect targets get no credential.
- **Domain modules** (`packages/hub-api/src/domains/`) — bounded per-domain implementations
  (auth, repos-read, repos-write, datasets, discussions, collections, community, profiles, spaces)
  behind the unchanged `HubClient` facade; typed mappers turn raw payloads into shared types and
  fail on contract drift instead of faking success.
- **Capability diagnostics** — a closed degradation model (`available`, `session-required`,
  `unauthorized`, `forbidden`, `rate-limited`, `upstream-changed`, `network`) surfaced in
  Diagnostics with user-triggered probes only; a failure in one capability never marks unrelated
  capabilities unavailable.

### Accounts & identity

- **Encrypted multi-account profiles** — the v1 single-token file migrates atomically to a v2
  encrypted store with per-account profiles (UUID, endpoint binding, cached validated identity,
  optional account-matched web session); corrupt files are backed up (timestamped, retained
  newest-five) and require explicit reauthentication.
- **Account switching** — validated add/switch/remove with no automatic fallback; endpoint
  mismatches fail typed; web sessions must match the active account.
- **Account-scoped state** — downloads, app-token clones, and uploads pin their creation account
  and fail typed (`account-unavailable`) instead of substituting credentials; follows and inbox are
  account-scoped while favorites/history stay device-global. Account removal is blocked while
  nonterminal tasks reference the profile.

### Local data integrity

- **Cache verification** — a worker verifies HF cache structure and blob hashes; verification never
  deletes anything.
- **Prune & repair plans** — two-phase, main-owned, expiring plans; applying a plan revalidates the
  filesystem against the plan digest, checks protected tasks, and repairs only through the existing
  commit-pinned download manager. Repair never replaces good data with unverified bytes.
- **Cache UI** — the cache visualizer presents verification results and plan execution with typed
  outcomes.

### Transfers

- **Download plans** — every download starts from a reviewed, expiring plan that previews exact
  files, bytes, duplicates, active coverage, commit, cache paths, account, and proxy before
  queueing; no renderer-provided raw paths.
- **Upload recovery** — interrupted upload tasks persist metadata and a manifest fingerprint;
  after restart the app offers an explicit, safe retry after revalidation — it does not claim
  byte-level resume.

### Local workbench

- **Model readiness** — evidence-backed format/shard/cache/adapter states and export-tool readiness
  (Ollama, LM Studio, ComfyUI) with no inferred "will run" guarantees.
- **Dataset workbench** — current-page filtering, column tools, a compact current-page profile, and
  main-process CSV/JSONL export with formula escaping and atomic writes; no SQL engine, no
  renderer WASM.

### Space lifecycle administration

Stable official REST operations behind typed IPC (`hub:spaceRuntime`, `hub:spaceHardwareList`,
`hub:spacePause`, `hub:spaceHardwareSet`, `hub:spaceSleepTimeSet`, plus the existing
`hub:spaceRestart`/secrets/variables/logs):

- **Runtime** — `GET /api/spaces/{repoId}/runtime` parsed with a strict semantic contract: the
  `stage` field must exist; current/requested hardware, `gcTimeout`, sleep window, and
  storage/dev-mode fields are optional; unknown additive fields are tolerated for forward
  compatibility. The app parses storage/dev-mode only for compatibility and never renders or
  manages volumes or dev mode.
- **Hardware** — the public catalog is fetched without pricing fields (the mapper strips them);
  hardware switches send the official `{flavor, sleepTimeSeconds?}` body; free-tier→upgraded
  changes require typing the exact repo id and show a billing-may-start-immediately notice with
  **no currency or estimate**.
- **Pause / resume / restart** — pause requires confirmation; resume of a paused Space is a normal
  restart; factory reboots use `?factory=true` and require typed repo id confirmation.
- **Sleep time** — the official `{seconds}` payload with `-1` for never-sleep where accepted; the
  displayed duration comes only from the Hub response; `cpu-basic` without a reported window shows
  localized "Hub-managed automatic sleep" and disables custom input (no hardcoded 48-hour default).
- **Bounded polling** — after any lifecycle mutation the panel polls the runtime on a bounded,
  cancelable window and invalidates runtime/repo queries; secrets, variables, and logs stay
  intact. Mutations are never retried on server failures.

### API stability classes

Every Hub operation belongs to one closed class; Diagnostics and error recovery are built on these
labels:

| Class             | Credential/source                | Stability expectation                                         |
| ----------------- | -------------------------------- | ------------------------------------------------------------- |
| `official-token`  | Hub access token                 | Official API contract; degrades on auth/permission/rate limit |
| `official-public` | Public API, optional token       | Official public contract                                      |
| `cookie-web`      | Hub web-session cookie           | Compatibility feature; may change independently               |
| `ssr-scrape`      | Hub-rendered HTML                | Compatibility feature; HTML changes may disable it            |
| `datasets-server` | Separate datasets-server service | Separate service contract                                     |

### Account, transfer, and cache recovery at a glance

- Credentials: fail-closed migration, timestamped corrupt-file backups, no plaintext on disk, no
  credentials in SQLite/logs/support bundles.
- Transfers: clone state recovers on restart (`interrupted` → resumable); downloads resume in the
  standard HF cache layout; uploads recover as explicit revalidated retries.
- Cache: verification is read-only; prune/repair require a fresh main-owned plan and revalidation;
  protected tasks block destructive plans.

## Maintenance cadence

- **Every push/PR**: lint, typecheck, unit tests, i18n parity and extraction checks, docs contract,
  privilege/no-updater policies, Gitleaks history scan.
- **Weekly (scheduled)**: full Windows stability run — verification suite, native rebuild tests,
  packaged smoke, dependency audit.
- **Per release**: CycloneDX 1.7 SBOM generation and verification, preflight asset checks
  (exactly ZIP + SHA-256 + SBOM), remote asset verification, packaged smoke; see
  [releasing.md](releasing.md).
- **On UI change**: the deterministic screenshot matrix must pass; baseline updates need a diff
  report and explicit visual approval.
- **Docs**: `corepack pnpm test:docs` gates required documents, guide section parity (en/zh-CN),
  relative links, and identity/version consistency.

## CI and SBOM summary

Workflows: `verify.yml` (the full gate), `release.yml` (detect → verify → build → preflight →
publish with least privileges), `stability-weekly.yml` (scheduled), `gitleaks.yml` (push/PR),
CodeQL. Release provenance is the unsigned ZIP + SHA-256 + verified CycloneDX 1.7 SBOM; the
internal asset inventory is verified remotely but never published.

## Explicit exclusions

The roadmap deliberately does **not** pursue Hugging Face's broader cloud products or unsafe
scope creep. Permanently out of scope for this client:

- Jobs and Inference Endpoints management
- Buckets, Webhooks, Sandboxes, and MCP surfaces
- Space volumes, dev mode, SSH terminals, and metrics dashboards
- Organization resource groups and admin consoles
- Any Space price display, price scraping, or monetary estimates
- No telemetry, no analytics, no remote feature flags, and no self-update mechanism
- No installers, no additional OS targets, and no code-signing policy changes
- Renderer-side network access, raw IPC, embedded terminals, or SQL/WASM data engines

## Future direction (not scheduled)

Candidate ideas are recorded here as intent only. **No future version, feature, or date mentioned
below is released, promised, or under contract** — items land only when implemented on `main` and
documented in the changelog at release time.

- Deeper cache analytics on top of the verification report (still local-only, still read-only
  first).
- More export targets for the model workbench, driven by the same evidence-backed readiness rules.
- Small, stable Hub API additions that fit the existing capability classes (for example read-only
  organization browsing), each gated by the same wire-level contract tests.
- Continued accessibility and localization hardening across all nine locales.

Ideas that would require breaking an explicit exclusion above are rejected regardless of demand.
