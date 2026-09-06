# Releasing

HubFetch ships a single **unsigned Windows x64 ZIP**. Releases are built and verified before GitHub
receives a tag or draft release. The workflow supports both a release commit on `main` and a
side-effect-free manual dry-run.

## Release contract

All four workspace manifests must contain the same plain `x.y.z` version:

- `package.json`
- `apps/desktop/package.json`
- `packages/shared/package.json`
- `packages/hub-api/package.json`

A push to `main` starts a real release only when the head commit subject matches
`[RELEASE] Vx.y.z`. The `V` is optional and case-insensitive, and the parsed version must equal all
four manifest versions. Other pushes finish after detection without creating release resources.

The installable release artifact is exactly one file: `HubFetch-<version>-windows-x64.zip`, built
unsigned via electron-builder's `zip` target (`win.target: zip`, `arch: x64`). There is no installer,
no `portable` target, no macOS/Linux packaging, and no updater/feed metadata. Release metadata ships
alongside the ZIP as `HubFetch-<version>-windows-x64.zip.sha256` and
`HubFetch-<version>.cdx.json` (CycloneDX 1.7 SBOM). Preflight also writes the internal
`release-assets.json` inventory; that inventory is verified against the remote asset list but is not
uploaded as a public release asset.

## Cutting a release

1. Update all four manifest versions in one change and run the full local verification suite.
2. Land the release commit as the head of `main` with subject `[RELEASE] Vx.y.z`.
3. Monitor `.github/workflows/release.yml`. It runs these gates in order:
   - **detect** parses the version and verifies the four manifests;
   - **verify** runs production dependency audit, format, lint, typecheck, coverage, build, SBOM
     generation/verification, and the full Windows E2E suite;
   - **build** packages the unsigned Windows x64 ZIP with `--publish never`, then runs the packaged
     smoke test;
   - **preflight** checks that exactly the Windows x64 ZIP and versioned SBOM are present (rejecting
     installers, updater metadata, other platforms, malformed SBOMs, and path or credential leaks),
     then writes the SHA-256 checksum and three-asset inventory;
   - **publish** creates or resumes the draft, uploads only preflight-approved public assets (ZIP +
     SHA-256 + SBOM), downloads them again to verify the remote asset set and hashes, and only then
     removes draft status.

Every runner is `windows-latest`; all release tooling is Node (no bash/jq requirement). Only
`publish` has `contents: write`. A failure in any earlier stage cannot create a tag or GitHub
Release.

## Unsigned disclosure

The Windows x64 ZIP is **unsigned**. Windows SmartScreen may warn on first launch; users choose
"More info → Run anyway" and verify the downloaded ZIP against its published SHA-256. There is no
code-signing requirement in the build, no signing secret in CI, and the release notes disclose this
explicitly. See [signing.md](signing.md).

## Dry-run

Run the **Release** workflow manually with `dry_run=true` (the default). It executes verification,
the Windows build, the packaged smoke test, and preflight, but it never creates a tag, draft, or
published release.

Use dry-run before changing release automation.

## SBOM verification

The repository-pinned package-manager toolchain generates the release SBOM without adding an SBOM dependency:

```sh
corepack pnpm release:sbom
node .github/scripts/release-tools/verify-sbom.mjs \
  artifacts/release/HubFetch-<version>.cdx.json
```

The verifier requires CycloneDX 1.7, all four workspace components, resolved dependency edges, and
workspace license metadata. A transitive component whose package metadata has no license is retained
in the deterministic `warningInventory` recorded in `release-assets.json` and `release-manifest.json`.
It does not reject the SBOM. `UNLICENSED`, an unresolved `SEE LICENSE IN` reference, or a missing
workspace license is a hard failure, as are local absolute paths, environment values, tokens, cookies,
and proxy credentials.

## Recovery and idempotency

Release runs share a repository-wide concurrency lock and are not canceled by newer runs. If a real
publish job is retried:

- an existing tag must point to the exact verified commit;
- an existing draft is reused and its assets are replaced from the verified artifact set;
- a published release is treated as complete only when downloading it reproduces the preflight
  asset list, sizes, and SHA-512 hashes;
- a tag pointing elsewhere or any asset mismatch stops the workflow without altering the release.

Do not delete and recreate a successful release merely to rerun CI. For a genuinely new release,
bump the patch version and land a new release commit.

## Scheduled stability maintenance

Between releases, three scheduled/policy gates keep the tree release-ready:

- **Weekly stability run** (`stability-weekly.yml`, Windows): full verification plus native rebuild
  tests, packaged smoke, and dependency audit on a fixed schedule, so drift is caught without a
  release attempt.
- **Secret scanning** (`gitleaks.yml`): every push and pull request scans full history with
  read-only permissions.
- **Visual baselines**: the Playwright screenshot matrix must pass deterministically; baseline
  changes require a diff report and explicit approval.

Keep these gates green: the release workflow re-runs the same core verification before it allows a
tag or draft release.

## Updater absence

HubFetch has no self-update capability (plan Todo 16 removed it). There is no `electron-updater`,
no `publish` metadata in `electron-builder.yml`, and the release produces no `latest.yml`,
`app-update.yml`, or `.blockmap` artifacts. Release preflight therefore does not validate updater
manifests; updates are manual — users install a newer build from the GitHub Releases page. Keep the
release's installable artifact and its SHA-256 checksum consistent so manual downloads verify
cleanly.
