# HubFetch

HubFetch is an early-stage Windows desktop project for managing local Hugging
Face download and Git clone workflows. This repository currently contains only
the project scaffold and strict development toolchain.

HubFetch is an independent project and is not affiliated with or endorsed by
Hugging Face, Inc.

## Prerequisites

- Windows 11 x64
- Python 3.12
- `uv`
- Git

## Development

```powershell
uv sync --frozen
uv run ruff format --check .
uv run ruff check .
uv run basedpyright
uv run pytest -q
uv run python scripts/check_no_excuse_rules.py .
```

Project documentation will be maintained in the repository's `docs/`
directory as implementation progresses.
