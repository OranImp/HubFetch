"""Given/When/Then tests for the portable Windows smoke contract.

Todo 30 gates the portable archive: AMD64 PE entry points, source-independent
imports, isolated app data, required license/plugin/DLL inventory, and zero
sentinel bytes. The disposable AskPass credential cycle lives in
``test_askpass_contract.py``. These tests lock the pure decision logic shared
with the packaged ``hubfetch.smoke``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hubfetch import smoke

_PE_SIGNATURE = b"PE\x00\x00"
_MACHINE_AMD64 = 0x8664
_MACHINE_I386 = 0x014C


def _pe_header(machine: int) -> bytes:
    """Build a minimal valid MZ+PE header declaring one machine type."""
    e_lfanew = 0x40
    header = bytearray(b"MZ" + b"\x00" * (e_lfanew - 2))
    header[0x3C:0x40] = e_lfanew.to_bytes(4, "little")
    header += _PE_SIGNATURE
    header += machine.to_bytes(2, "little")
    header += b"\x00" * 18
    return bytes(header)


def test_pe_machine_type_classifies_headers() -> None:
    """Given PE headers, When inspected, Then amd64 is matched and others not."""
    assert smoke.pe_machine_type(_pe_header(_MACHINE_AMD64)) == _MACHINE_AMD64
    assert smoke.is_amd64_pe(_pe_header(_MACHINE_AMD64)) is True
    assert smoke.is_amd64_pe(_pe_header(_MACHINE_I386)) is False
    assert smoke.pe_machine_type(b"MZ") is None
    assert smoke.pe_machine_type(_pe_header(_MACHINE_AMD64)[:20]) is None
    assert smoke.pe_machine_type(b"not a portable executable") is None


def test_sentinel_scan_finds_embedded_token(tmp_path: Path) -> None:
    """Given blobs or trees, When scanned, Then embedding files are found."""
    assert smoke.contains_sentinel(b"prefix" + smoke.SENTINEL + b"suffix") is True
    assert smoke.contains_sentinel(b"hf_ something else entirely") is False
    dirty = tmp_path / "dirty.bin"
    _ = dirty.write_bytes(b"token=" + smoke.SENTINEL)
    _ = (tmp_path / "clean.txt").write_text("clean", encoding="utf-8")
    assert smoke.scan_tree_for_sentinel(tmp_path) == (dirty,)


def test_parse_smoke_args_accepts_smoke_test() -> None:
    """Given smoke flags, When parsed, Then mode and root are returned."""
    args = smoke.parse_smoke_args(
        ("--smoke-test", "--app-data-root", r"C:\portable\app-data")
    )

    assert args.mode == "smoke"
    assert args.app_data_root == Path(r"C:\portable\app-data")


def test_parse_smoke_args_accepts_capture_with_png() -> None:
    """Given capture flags, When parsed, Then mode and PNG path are returned."""
    args = smoke.parse_smoke_args(
        (
            "--smoke-capture",
            r"C:\portable\shell.png",
            "--app-data-root",
            r"C:\portable\app-data",
        )
    )

    assert args.mode == "capture"
    assert args.capture_path == Path(r"C:\portable\shell.png")


def test_parse_smoke_args_rejects_malformed_invocations() -> None:
    """Given malformed argv, When parsed, Then a usage error is raised."""
    with pytest.raises(ValueError, match="missing --smoke-test"):
        _ = smoke.parse_smoke_args(("--app-data-root", r"C:\portable\app-data"))
    with pytest.raises(ValueError, match="unrecognized smoke argument"):
        _ = smoke.parse_smoke_args(("--bogus",))


def test_is_smoke_request_recognizes_both_flags() -> None:
    """Given either smoke flag, When inspected, Then it is recognized."""
    assert smoke.is_smoke_request(("--smoke-test",)) is True
    assert smoke.is_smoke_request(("--smoke-capture", "out.png")) is True
    assert smoke.is_smoke_request(("--showcase",)) is False


def test_smoke_result_json_is_deterministic() -> None:
    """Given two identical results, When serialized, Then JSON is identical."""
    askpass = smoke.AskPassContractResult(
        backend="module.Fake",
        alias_created=True,
        username_outcome=True,
        password_outcome=True,
        token_matched=True,
        token_deleted=True,
        error=None,
    )
    result = smoke.SmokeResult(
        python_exe=r"C:\portable\HubFetch.exe",
        frozen=True,
        pe_architecture="amd64",
        module_origins={"hubfetch": r"C:\portable\_internal\hubfetch\__init__.py"},
        sys_path=(r"C:\portable\_internal",),
        qt_platform="windows",
        fonts_registered=("Cascadia Mono",),
        settings_roundtrip=True,
        database_created=True,
        package_inventory_ok=True,
        missing_package_entries=(),
        forbidden_package_entries=(),
        sentinel_files=(),
        askpass=askpass,
        errors=(),
    )

    first = result.to_json()

    assert first == result.to_json()
    assert json.loads(first)["pe_architecture"] == "amd64"
    assert json.loads(first)["errors"] == []


def test_required_package_inventory_covers_license_qt_and_plugins() -> None:
    """Given the inventory, When inspected, Then required entries are present."""
    entries = set(smoke.REQUIRED_PACKAGE_ENTRIES)

    required = {
        "HubFetch.exe",
        "HubFetchAskPass.exe",
        "licenses/LICENSE",
        "licenses/THIRD_PARTY_NOTICES.md",
        "licenses/qt/LGPL-3.0.txt",
        "licenses/qt/GPL-3.0.txt",
        "resources/fonts/CascadiaMono.ttf",
        "resources/fonts/OFL.txt",
        "resources/icons/settings.svg",
        "hubfetch/persistence/sql/001_initial.sql",
        "PySide6/plugins/platforms/qwindows.dll",
        "PySide6/plugins/tls/qschannelbackend.dll",
        "PySide6/plugins/imageformats/qsvg.dll",
        "PySide6/translations/qtbase_zh_CN.qm",
        "hubfetch/i18n/hubfetch_zh_CN.qm",
        "PySide6/Qt6Core.dll",
        "PySide6/Qt6Gui.dll",
        "PySide6/Qt6Widgets.dll",
    }
    assert required <= entries


def test_forbidden_package_path_detection() -> None:
    """Given packaged paths, When checked, Then banned entries are rejected."""
    assert smoke.is_forbidden_package_path("_internal/git.exe") is True
    assert smoke.is_forbidden_package_path("_internal/git-xet/bin/git-xet") is True
    assert smoke.is_forbidden_package_path("_internal/app.db") is True
    assert smoke.is_forbidden_package_path("_internal/PySide6/Qt6Core.dll") is False
