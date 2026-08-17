# Contributing

Thanks for helping with HubFetch! This project is an unofficial, community-built Windows desktop
client for the Hugging Face Hub, licensed under Apache-2.0.

This page summarizes the contribution process. The full ground rules, setup, workflow, and
"adding a language" instructions live in [`CONTRIBUTING.md`](../CONTRIBUTING.md) at the repository
root.

## Ground rules (summary)

- **English** for code, identifiers, comments, commit messages, and repository docs.
- **No hardcoded user-facing strings.** Every string a user can see goes through i18n
  (`react-i18next` in the renderer, the `t()` helper in the main process). CI enforces this.
- **No Hugging Face branding.** Never add the 🤗 emoji, HF logos, or anything implying official
  status. HubFetch is an independent fork with its own identity.
- **Privacy-first.** No telemetry, no third-party services. Tokens are only ever stored encrypted
  via `safeStorage`.
- **Security baseline.** Renderer stays sandboxed; all IPC goes through the typed contract in
  `packages/shared` and validates input in the handler.

## Setup

```sh
corepack enable
pnpm install
pnpm dev
```

## Before you open a PR

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:docs      # docs link / contract / notices / command-reference policy
pnpm test:no-updater
pnpm test:privileges
pnpm test:release-tools
```

## Documentation

Documentation lives in `docs/` (user guides in English and 简体中文, plus architecture, security,
troubleshooting, releasing, and upstream-sync) and in the root `README.md`, `UPSTREAM_SOURCE.md`,
and `THIRD_PARTY_NOTICES.md`. If you change behavior, update the corresponding docs; the doc policy
tests in `pnpm test:docs` verify that links resolve, the paired guides stay in sync, notices
reconcile with the dependency inventory, and every documented command matches the real manifests.
