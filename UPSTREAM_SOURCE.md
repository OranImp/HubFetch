# UPSTREAM_SOURCE.md - import provenance for the promoted ohmyhf snapshot

## Source

- Repository URL: `https://github.com/fzlzjerry/ohmyhf.git`
  (alias: `oh-my-hf/ohmyhf`; the original plan-literal huggingface/oh-my-huggingface URL
  returns 404 and was user-corrected on 2026-08-16, see Todo 2 correction-verdict.json.)
- Upstream release tag: `v0.0.9` (upstream commit `3bdf5d6027395bb2bbdd611930012712edf8d7b0`)
- Snapshot status: **untouched upstream v0.0.9 snapshot imported at the cutover commit**.
  No source file was modified, rebranded, or adapted in this commit.

## License

- `Apache-2.0` (see `LICENSE` in this repository root; identical to the upstream file).

## Modification statement

This commit imports the upstream v0.0.9 snapshot unmodified. Rebranding and adaptation
to HubFetch will follow in later, separate commits. The upstream project (Oh My HuggingFace)
is an independent community project and is not affiliated with or endorsed by Hugging Face, Inc.

## Archive references (pre-cutover PySide6 HubFetch)

- Branch: `archive/pyside-hubfetch-0.1.0`
- Tag: `v0.1.0-pyside-hubfetch`
- Both pinned to the pre-cutover commit `6ce8808f64da9935c8612b28c9306f54ad0b4cc1`.

## Cutover facts

- Date: 2026-08-16
- Pre-cutover SHA: `6ce8808f64da9935c8612b28c9306f54ad0b4cc1`
- Imported inventory: 493 files (see `.omo/evidence/task-3-adopt-ohmyhf-main/incoming-manifest.json`)
- Commit: `chore(repo): promote ohmyhf snapshot to repository root`
