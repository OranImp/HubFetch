"""Generate THIRD_PARTY_NOTICES.md and a machine-readable manifest.

Usage:
    uv run python scripts/generate_notices.py                # write outputs
    uv run python scripts/generate_notices.py --check        # verify committed notices

Both modes derive the Windows runtime dependency closure from the frozen
``uv.lock`` plus ``packaging/license_overrides.toml``. Generation is
deterministic: identical inputs produce byte-identical outputs. ``--check``
fails when any license is missing/unknown/disallowed or when the committed
notices are not byte-identical to a fresh render.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING, Final, final

if TYPE_CHECKING:
    from collections.abc import Sequence

_REPO_ROOT = Path(__file__).resolve().parents[1]
_MAX_OPTIONAL_ARGS: Final = 4
_OUT_INDEX: Final = 2
_MANIFEST_INDEX: Final = 3
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts.license_manifest import (  # noqa: E402
    LicensePolicyError,
    check,
    generate,
    license_violations,
    parse_lock,
    parse_overrides,
    render_notices,
    report_errors,
    runtime_package_names,
)

# The policy API is re-exported from scripts.license_manifest so that tests and
# tooling can import the whole notice surface from this entry point.
__all__ = [
    "LicensePolicyError",
    "check",
    "generate",
    "license_violations",
    "main",
    "parse_lock",
    "parse_overrides",
    "render_notices",
    "report_errors",
    "runtime_package_names",
]


@final
class _Options:
    """Parsed command-line options for the notice generator."""

    check: bool
    lock: Path
    overrides: Path
    out: Path
    manifest: Path

    def __init__(self, arguments: Sequence[str]) -> None:
        self.check = "--check" in arguments
        remaining = [argument for argument in arguments if argument != "--check"]
        if len(remaining) > _MAX_OPTIONAL_ARGS:
            message = f"too many arguments: {' '.join(remaining)}"
            raise ValueError(message)
        self.lock = Path(remaining[0]) if len(remaining) > 0 else _REPO_ROOT / "uv.lock"
        self.overrides = (
            Path(remaining[1])
            if len(remaining) > 1
            else _REPO_ROOT / "packaging" / "license_overrides.toml"
        )
        self.out = (
            Path(remaining[_OUT_INDEX])
            if len(remaining) > _OUT_INDEX
            else _REPO_ROOT / "THIRD_PARTY_NOTICES.md"
        )
        self.manifest = (
            Path(remaining[_MANIFEST_INDEX])
            if len(remaining) > _MANIFEST_INDEX
            else _REPO_ROOT / "build" / "package-manifest.json"
        )


def main(arguments: Sequence[str] | None = None) -> int:
    """Run the notice generator; return the process exit code."""
    try:
        options = _Options(arguments if arguments is not None else sys.argv[1:])
        if options.check:
            passed, failures = check(options.lock, options.overrides, options.out)
            report_errors("generate-notices", failures)
            exit_code = 0 if passed else 1
        else:
            generate(options.lock, options.overrides, options.out, options.manifest)
            print(f"generate-notices: wrote {options.out} and {options.manifest}")
            exit_code = 0
    except (LicensePolicyError, OSError, ValueError) as error:
        print(f"generate-notices: {error}", file=sys.stderr)
        exit_code = 2
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
