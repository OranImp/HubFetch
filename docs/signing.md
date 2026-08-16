# Code signing

HubFetch ships a single **unsigned Windows x64 ZIP**. There is no code-signing requirement in the
build, no signing certificate in CI, and no platform where a signature is enforced. This document
states the disclosure and tracks what would be needed for real Windows signing later.

## Current state: unsigned

- `apps/desktop/electron-builder.yml` targets `win.target: zip` with `arch: x64` only. No
  `certificateFile`/`signtool`/`azureSign` configuration, no `forceCodeSigning`, and no macOS/Linux
  signing config of any kind.
- CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and passes no signing secrets. The produced
  `HubFetch-<version>-windows-x64.zip` is therefore unsigned.
- Windows SmartScreen may warn when a user runs the extracted `HubFetch.exe` for the first time.
  Users verify the ZIP against its published SHA-256 checksum (written at release preflight and
  uploaded next to the ZIP) and choose "More info → Run anyway" if the warning appears.
- Release notes and [releasing.md](releasing.md) disclose the unsigned status explicitly.

## Windows: optional signing

Unsigned archives still show SmartScreen on first launch. Options if code signing is ever added:

- an OV/EV code-signing certificate via `CSC_LINK`/`CSC_KEY_PASSWORD`, or
- Azure Trusted Signing via `azureSignOptions` in electron-builder.

If signing is introduced, the packaging policy tests in
`.github/scripts/release-tools/release-tools.test.mjs` must be updated to require a signing
configuration instead of forbidding one, and the unsigned disclosure in this document and in
`docs/releasing.md` must be removed.

## No updater implications

Because the app has no self-update capability (plan Todo 16 removed `electron-updater`), there is
no update-signature constraint: nothing pins an installed app to a publisher certificate, and the
manual-download flow only needs the SHA-256 checksum to match.
