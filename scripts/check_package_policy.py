"""Policy checker over packaging/hubfetch.spec.

Parses the spec as a declarative Python document (without executing it) and
verifies the exact entry points, the one-folder COLLECT layout, prohibited
constructs (UPX, one-file, bundled Git/Xet/hf binaries, database and
research/cache/log paths), GPL-only Qt module exclusions, the required
replaceable-Qt resource plan, and a complete license mapping derived from the
frozen uv.lock. Run with ``--json <path>`` to emit a machine-readable report.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts import license_manifest  # noqa: E402
from scripts._policy_constants import (  # noqa: E402
    BANNED_BINARY,
    DATABASE_PATH,
    EXPECTED_COLLECT,
    EXPECTED_ENTRYPOINTS,
    FORBIDDEN_SEGMENT,
    GPL_ONLY_QT_MODULES,
    REQUIRED_QT_DLLS,
    REQUIRED_RESOURCES,
)
from scripts._spec_model import SpecModel, parse_spec  # noqa: E402

__all__ = [
    "GPL_ONLY_QT_MODULES",
    "PolicyFailure",
    "PolicyReport",
    "parse_spec",
    "run_policy",
]


@dataclass(frozen=True, slots=True)
class PolicyFailure:
    """One named policy rule violation."""

    rule: str
    message: str


@dataclass(frozen=True, slots=True)
class PolicyReport:
    """The outcome of a full policy run."""

    passed: bool
    failures: tuple[PolicyFailure, ...]
    inventory: Mapping[str, object]


def _check_entry_points(model: SpecModel) -> list[PolicyFailure]:
    actual = {(entry.name, entry.console) for entry in model.entrypoints}
    failures: list[PolicyFailure] = []
    if actual != set(EXPECTED_ENTRYPOINTS):
        failures.append(
            PolicyFailure(
                "entry-points",
                f"expected {sorted(EXPECTED_ENTRYPOINTS)}, found {sorted(actual)}",
            )
        )
    if model.collect_name != EXPECTED_COLLECT:
        failures.append(
            PolicyFailure(
                "collect-layout", f"expected COLLECT named {EXPECTED_COLLECT!r}"
            )
        )
    return failures


def _check_prohibited_flags(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    if model.one_file:
        failures.append(
            PolicyFailure("one-file-forbidden", "one-file EXE mode is prohibited")
        )
    if model.upx:
        failures.append(PolicyFailure("upx-forbidden", "UPX compression is prohibited"))
    return failures


def _check_forbidden_paths(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    for destination, basename in model.resource_plan:
        if BANNED_BINARY.match(basename):
            failures.append(
                PolicyFailure(
                    "bundled-binary",
                    f"{destination}/{basename} bundles a Git/Xet/hf binary",
                )
            )
        if DATABASE_PATH.search(destination) or DATABASE_PATH.search(basename):
            failures.append(
                PolicyFailure(
                    "database-path", f"{destination}/{basename} carries a database file"
                )
            )
        segments = destination.split("/")
        if FORBIDDEN_SEGMENT.intersection(segments):
            failures.append(
                PolicyFailure(
                    "forbidden-path",
                    f"{destination} contains a research/evidence/cache/log path",
                )
            )
    return failures


def _check_qt_modules(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    excluded = set(model.excludes)
    hidden = set(model.hidden_imports)
    missing = GPL_ONLY_QT_MODULES - excluded
    if missing:
        failures.append(
            PolicyFailure(
                "gpl-only-qt-exclude",
                f"GPL-only Qt modules not excluded: {sorted(missing)}",
            )
        )
    present = GPL_ONLY_QT_MODULES.intersection(hidden)
    if present:
        failures.append(
            PolicyFailure(
                "gpl-only-qt-import",
                f"GPL-only Qt modules hidden-imported: {sorted(present)}",
            )
        )
    return failures


def _check_resources(model: SpecModel) -> list[PolicyFailure]:
    failures: list[PolicyFailure] = []
    plan = set(model.resource_plan)
    missing_resources = REQUIRED_RESOURCES - plan
    if missing_resources:
        failures.append(
            PolicyFailure(
                "required-resources", f"missing resources: {sorted(missing_resources)}"
            )
        )
    dlls = set(model.expected_qt_dlls)
    missing_dlls = REQUIRED_QT_DLLS - dlls
    if missing_dlls:
        failures.append(
            PolicyFailure(
                "replaceable-qt-dlls",
                f"missing Qt DLL declarations: {sorted(missing_dlls)}",
            )
        )
    if not model.uses_dynamic_qt:
        failures.append(
            PolicyFailure(
                "replaceable-qt-layout", "spec must collect PySide6 DLLs dynamically"
            )
        )
    return failures


def _check_licenses(repo_root: Path) -> list[PolicyFailure]:
    lock_text = (repo_root / "uv.lock").read_text(encoding="utf-8")
    overrides = license_manifest.parse_overrides(
        (repo_root / "packaging" / "license_overrides.toml").read_text(encoding="utf-8")
    )
    violations = license_manifest.license_violations(
        license_manifest.parse_lock(lock_text), overrides
    )
    return [PolicyFailure("license-policy", f"{violation}") for violation in violations]


def run_policy(spec_path: Path, repo_root: Path) -> PolicyReport:
    """Run every policy rule against a spec and the frozen lock."""
    model = parse_spec(spec_path)
    failures = [
        *_check_entry_points(model),
        *_check_prohibited_flags(model),
        *_check_forbidden_paths(model),
        *_check_qt_modules(model),
        *_check_resources(model),
        *_check_licenses(repo_root),
    ]
    inventory: dict[str, object] = {
        "spec": str(spec_path),
        "entrypoints": [(entry.name, entry.console) for entry in model.entrypoints],
        "collect": model.collect_name,
        "resource_plan_size": len(model.resource_plan),
        "excluded_modules": len(model.excludes),
        "runtime_packages": sorted(
            license_manifest.runtime_package_names(
                license_manifest.parse_lock(
                    (repo_root / "uv.lock").read_text(encoding="utf-8")
                )
            )
        ),
    }
    return PolicyReport(not failures, tuple(failures), inventory)


def main(arguments: Sequence[str] | None = None) -> int:
    """Run the checker over a spec path, optionally writing a JSON report."""
    args = list(arguments if arguments is not None else sys.argv[1:])
    json_path: Path | None = None
    if "--json" in args:
        index = args.index("--json")
        if index + 1 >= len(args):
            print("check-package-policy: --json requires a path", file=sys.stderr)
            return 2
        json_path = Path(args.pop(index + 1))
        _ = args.pop(index)
    if len(args) != 1:
        print("check-package-policy: expected <spec> [--json <path>]", file=sys.stderr)
        return 2
    try:
        report = run_policy(Path(args[0]), _REPO_ROOT)
    except (OSError, ValueError) as error:
        print(f"check-package-policy: {error}", file=sys.stderr)
        return 2
    payload = {
        "passed": report.passed,
        "failures": [
            {"rule": failure.rule, "message": failure.message}
            for failure in report.failures
        ],
        "inventory": report.inventory,
    }
    if json_path is not None:
        _ = json_path.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    for failure in report.failures:
        print(
            f"check-package-policy: [{failure.rule}] {failure.message}", file=sys.stderr
        )
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
