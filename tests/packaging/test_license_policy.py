"""Given/When/Then tests for the frozen-lock license policy and notices.

The tests exercise the pure policy logic in scripts/generate_notices.py: the
Windows-filtered runtime closure over uv.lock, the curated license overrides,
the rejection of unknown or GPL-only Qt licenses, and byte-identical notice
output for identical inputs.
"""

from __future__ import annotations

from pathlib import Path

from scripts import generate_notices as notices

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = REPO_ROOT / "uv.lock"
OVERRIDES_PATH = REPO_ROOT / "packaging" / "license_overrides.toml"

_LOCK_HEADER = "version = 1\n"
_LOCK_PROJECT = (
    "[[package]]\n"
    'name = "hubfetch"\n'
    'version = "0.1.0"\n'
    'source = { editable = "." }\n'
    'dependencies = [{ name = "pyside6" }]\n'
)
_LOCK_PYSIDE = (
    "[[package]]\n"
    'name = "pyside6"\n'
    'version = "6.11.1"\n'
    'source = { registry = "https://mirrors.aliyun.com/pypi/simple/" }\n'
    'dependencies = [{ name = "shiboken6" }]\n'
)
_LOCK_SHIBOKEN = (
    "[[package]]\n"
    'name = "shiboken6"\n'
    'version = "6.11.1"\n'
    'source = { registry = "https://mirrors.aliyun.com/pypi/simple/" }\n'
)

_OVERRIDES_BASE = (
    '[project]\nname = "hubfetch"\nversion = "0.1.0"\nlicense = "MIT"\n'
    '[licenses]\npyside6 = "LGPL-3.0-only"\nshiboken6 = "LGPL-3.0-only"\n'
    "[allowed]\nLGPL-3.0-only = true\n"
    "[disallowed]\nGPL-3.0-only = true\n"
)


def _overrides_text(extra_licenses: str = "") -> str:
    """Return overrides TOML text with optional extra license lines."""
    return _OVERRIDES_BASE + extra_licenses


def _overrides_without(license_lines: str) -> str:
    """Return overrides TOML text with the [licenses] section replaced."""
    return (
        f'[project]\nname = "hubfetch"\nversion = "0.1.0"\nlicense = "MIT"\n'
        f"[licenses]\n{license_lines}[allowed]\nLGPL-3.0-only = true\n"
        "[disallowed]\nGPL-3.0-only = true\n"
    )


def test_unknown_runtime_license_is_rejected() -> None:
    """Given a runtime dependency absent from the license overrides, When the
    policy validates the closure, Then a named missing-license violation
    exists.
    """
    lock = notices.parse_lock(
        _LOCK_HEADER + _LOCK_PROJECT + _LOCK_PYSIDE + _LOCK_SHIBOKEN
    )
    overrides = notices.parse_overrides(
        _overrides_without('pyside6 = "LGPL-3.0-only"\n')
    )
    violations = notices.license_violations(lock, overrides)

    assert any("missing-license" in message for message in violations)


def test_gpl_only_qt_license_is_rejected() -> None:
    """Given a Qt package overridden to a GPL-only license, When the policy
    validates, Then a named GPL-only-Qt violation exists.
    """
    lock = notices.parse_lock(
        _LOCK_HEADER + _LOCK_PROJECT + _LOCK_PYSIDE + _LOCK_SHIBOKEN
    )
    overrides = notices.parse_overrides(
        _overrides_without('pyside6 = "GPL-3.0-only"\nshiboken6 = "LGPL-3.0-only"\n')
    )
    violations = notices.license_violations(lock, overrides)

    assert any("gpl-only-qt" in message for message in violations)


def test_allowed_runtime_closure_has_no_violations() -> None:
    """Given an LGPL Qt closure fully covered by the overrides, When the policy
    validates, Then no violations are reported.
    """
    lock = notices.parse_lock(
        _LOCK_HEADER + _LOCK_PROJECT + _LOCK_PYSIDE + _LOCK_SHIBOKEN
    )
    overrides = notices.parse_overrides(_overrides_text())
    violations = notices.license_violations(lock, overrides)

    assert violations == ()


def test_notices_are_byte_identical_across_runs() -> None:
    """Given the real frozen lock and overrides, When notices render twice,
    Then both byte strings are identical.
    """
    lock = notices.parse_lock(LOCK_PATH.read_text(encoding="utf-8"))
    overrides = notices.parse_overrides(OVERRIDES_PATH.read_text(encoding="utf-8"))

    first = notices.render_notices(lock, overrides)
    second = notices.render_notices(lock, overrides)

    assert first == second


def test_real_closure_includes_windows_marker_dependencies() -> None:
    """Given the real frozen lock, When the Windows runtime closure is
    computed, Then packages gated by ``sys_platform == 'win32'`` markers
    (colorama, pywin32-ctypes) and hf-xet are included and fully licensed.
    """
    lock = notices.parse_lock(LOCK_PATH.read_text(encoding="utf-8"))
    overrides = notices.parse_overrides(OVERRIDES_PATH.read_text(encoding="utf-8"))
    closure = notices.runtime_package_names(lock)

    assert {"colorama", "pywin32-ctypes", "hf-xet"} <= closure
    assert notices.license_violations(lock, overrides) == ()


def test_generate_is_reproducible_from_real_lock(tmp_path: Path) -> None:
    """Given two fresh output directories, When generate() runs twice against
    the same frozen inputs, Then every output file is byte-identical.
    """
    out_a = tmp_path / "a"
    out_b = tmp_path / "b"
    out_a.mkdir()
    out_b.mkdir()

    notices.generate(
        LOCK_PATH,
        OVERRIDES_PATH,
        out_a / "THIRD_PARTY_NOTICES.md",
        out_a / "package-manifest.json",
    )
    notices.generate(
        LOCK_PATH,
        OVERRIDES_PATH,
        out_b / "THIRD_PARTY_NOTICES.md",
        out_b / "package-manifest.json",
    )

    assert (out_a / "THIRD_PARTY_NOTICES.md").read_bytes() == (
        out_b / "THIRD_PARTY_NOTICES.md"
    ).read_bytes()
    assert (out_a / "package-manifest.json").read_bytes() == (
        out_b / "package-manifest.json"
    ).read_bytes()
