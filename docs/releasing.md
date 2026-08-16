# Releasing

Releases are built and verified before GitHub receives a tag or draft release. The workflow supports
both a release commit on `main` and a side-effect-free manual dry-run.

## Release contract

All four workspace manifests must contain the same plain `x.y.z` version:

- `package.json`
- `apps/desktop/package.json`
- `packages/shared/package.json`
- `packages/hub-api/package.json`

A push to `main` starts a real release only when the head commit subject matches
`[RELEASE] Vx.y.z`. The `V` is optional and case-insensitive, and the parsed version must equal all
four manifest versions. Other pushes finish after detection without creating release resources.

## Cutting a release

1. Update all four manifest versions in one change and run the full local verification suite.
2. Land the release commit as the head of `main` with subject `[RELEASE] Vx.y.z`.
3. Monitor `.github/workflows/release.yml`. It runs these gates in order:
   - **detect** parses the version and verifies the four manifests;
   - **verify** runs production dependency audit, format, lint, typecheck, coverage, build, and the
     full Ubuntu E2E suite;
   - **build** packages macOS, Windows, and Linux with `--publish never`, then runs the packaged
     smoke test on each platform;
   - **preflight** checks required installers, every referenced file, and its
     SHA-512 value;
   - **publish** creates or resumes the draft, uploads only preflight-approved assets, downloads
     them again to verify the remote asset set and hashes, and only then removes draft status.

Only `publish` has `contents: write`. A failure in any earlier stage cannot create a tag or GitHub
Release.

The regular CI workflow runs the full Ubuntu E2E suite for every pull request. After verification,
pushes to `main` also run the reusable macOS, Windows, and Linux packaged smoke matrix with
publishing disabled.

## Dry-run

Run the **Release** workflow manually with `dry_run=true` (the default). It executes verification,
all three platform builds, packaged smoke tests, and preflight, but it never creates a tag, draft, or
published release. Dry-run macOS artifacts use the configured ad-hoc identity; real releases require
the `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` secrets described in [signing.md](signing.md).

Use dry-run before changing release automation.

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

## Updater absence

HubFetch has no self-update capability (plan Todo 16 removed it). There is no `electron-updater`,
no `publish` metadata in `electron-builder.yml`, and the release produces no `latest.yml`,
`app-update.yml`, or `.blockmap` artifacts. Release preflight therefore does not validate updater
manifests; updates are manual — users install a newer build from the GitHub Releases page. Keep the
release's installable artifacts and their SHA-512 hashes consistent so manual downloads verify
cleanly.
