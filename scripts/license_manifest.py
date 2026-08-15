"""Deterministic third-party notice and license policy for HubFetch.

The module derives the Windows runtime dependency closure from the frozen
``uv.lock`` (parsed in scripts._lock_parse), applies the curated
``packaging/license_overrides.toml`` license map, and rejects missing, unknown,
or disallowed (GPL-only) licenses. Notice and manifest rendering is a pure
function of its inputs: identical inputs always produce byte-identical output.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from scripts._lock_parse import (  # noqa: E402
    LockDependency,
    LockModel,
    LockPackage,
    Overrides,
    ProjectInfo,
    marker_allows,
    parse_lock,
    parse_overrides,
)

__all__ = [
    "LicensePolicyError",
    "LockDependency",
    "LockModel",
    "LockPackage",
    "Overrides",
    "ProjectInfo",
    "check",
    "generate",
    "license_violations",
    "parse_lock",
    "parse_overrides",
    "render_manifest",
    "render_notices",
    "report_errors",
    "runtime_package_names",
]


class LicensePolicyError(RuntimeError):
    """Raised when the frozen dependency closure violates the license policy."""


def runtime_package_names(lock: LockModel) -> frozenset[str]:
    """Return the Windows runtime dependency closure of the project."""
    packages = {package.name: package for package in lock.packages}
    project = next((package for package in lock.packages if package.is_project), None)
    if project is None:
        return frozenset()
    visited: set[str] = set()
    frontier = [dependency.name for dependency in project.dependencies]
    while frontier:
        name = frontier.pop()
        if name in visited:
            continue
        visited.add(name)
        package = packages.get(name)
        if package is None:
            continue
        frontier.extend(
            dependency.name
            for dependency in package.dependencies
            if marker_allows(dependency.marker)
        )
    return frozenset(visited)


def _is_qt_package(name: str) -> bool:
    return name == "shiboken6" or name.startswith("pyside6")


def license_violations(lock: LockModel, overrides: Overrides) -> tuple[str, ...]:
    """Return named license-policy violations for the runtime closure."""
    violations: list[str] = []
    for name in sorted(runtime_package_names(lock)):
        license_id = overrides.licenses.get(name)
        if license_id is None:
            violations.append(f"{name}: missing-license (no override entry)")
            continue
        if license_id in overrides.disallowed_licenses:
            violations.append(f"{name}: disallowed-license ({license_id})")
            if _is_qt_package(name):
                violations.append(f"{name}: gpl-only-qt ({license_id})")
            continue
        if license_id not in overrides.allowed_licenses:
            violations.append(f"{name}: unknown-license ({license_id})")
    return tuple(violations)


def _version_map(lock: LockModel) -> Mapping[str, str]:
    return {package.name: package.version for package in lock.packages}


def render_notices(lock: LockModel, overrides: Overrides, lock_hash: str = "") -> str:
    """Render THIRD_PARTY_NOTICES.md deterministically from lock and overrides."""
    versions = _version_map(lock)
    lines: list[str] = [
        f"# {overrides.project.name} Third-Party Notices",
        "",
        (
            f"{overrides.project.name} {overrides.project.version} is "
            "distributed under the"
        ),
        f"{overrides.project.license} license; the full project license ships in this",
        "archive under `licenses/LICENSE`.",
        "",
        "This archive contains third-party software, each component under its own",
        "license. The license texts ship inside the archive under `licenses/`;",
        "component copyright holders are named by each license text.",
        "",
        f"Generated deterministically from `uv.lock` sha256 {lock_hash or '(unset)'}",
        "plus the curated `packaging/license_overrides.toml` license map.",
        "",
    ]
    for name in sorted(runtime_package_names(lock)):
        lines.extend(
            [
                f"## {name} {versions.get(name, '')}",
                f"- License: {overrides.licenses.get(name, 'unknown')}",
                f"- Homepage: {overrides.homepages.get(name, 'not declared')}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def render_manifest(
    lock: LockModel, overrides: Overrides, notices_text: str, lock_hash: str
) -> str:
    """Render the machine-readable package manifest deterministically."""
    versions = _version_map(lock)
    payload = {
        "generated_from": "uv.lock",
        "lock_sha256": lock_hash,
        "notices_sha256": hashlib.sha256(notices_text.encode("utf-8")).hexdigest(),
        "packages": [
            {
                "name": name,
                "version": versions.get(name, ""),
                "license": overrides.licenses.get(name, "unknown"),
                "homepage": overrides.homepages.get(name, ""),
            }
            for name in sorted(runtime_package_names(lock))
        ],
    }
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def generate(
    lock_path: Path,
    overrides_path: Path,
    notices_path: Path,
    manifest_path: Path,
) -> None:
    """Write deterministic notices and manifest, failing on license violations."""
    lock_text = lock_path.read_text(encoding="utf-8")
    overrides = parse_overrides(overrides_path.read_text(encoding="utf-8"))
    lock = parse_lock(lock_text)
    violations = license_violations(lock, overrides)
    if violations:
        raise LicensePolicyError("\n".join(violations))
    lock_hash = _sha256(lock_text)
    notices_text = render_notices(lock, overrides, lock_hash)
    notices_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    _ = notices_path.write_text(notices_text, encoding="utf-8")
    _ = manifest_path.write_text(
        render_manifest(lock, overrides, notices_text, lock_hash), encoding="utf-8"
    )


def check(
    lock_path: Path, overrides_path: Path, notices_path: Path
) -> tuple[bool, tuple[str, ...]]:
    """Validate the committed notices against a fresh deterministic render."""
    failures: list[str] = []
    lock_text = lock_path.read_text(encoding="utf-8")
    overrides = parse_overrides(overrides_path.read_text(encoding="utf-8"))
    lock = parse_lock(lock_text)
    failures.extend(license_violations(lock, overrides))
    expected = render_notices(lock, overrides, _sha256(lock_text))
    if not notices_path.exists():
        failures.append(f"{notices_path}: missing- notices file")
    elif notices_path.read_text(encoding="utf-8") != expected:
        failures.append(f"{notices_path}: not byte-identical to regenerated notices")
    return (not failures), tuple(failures)


def report_errors(
    prefix: str, failures: Sequence[str], stream: TextIO = sys.stderr
) -> None:
    """Write named policy failures to a stream."""
    for failure in failures:
        print(f"{prefix}: {failure}", file=stream)
