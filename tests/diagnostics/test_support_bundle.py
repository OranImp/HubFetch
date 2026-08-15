# noqa: SIZE_OK - one module must enumerate the whole support-bundle contract:
# exact allowlist membership, sentinel absence, denied paths, bounded logs,
# unreadable-log resilience, and deterministic rebuilds.

"""Given/When/Then contracts for the typed support-bundle ZIP export.

Todo 27 builds the support ZIP through an explicit allowlist: app/dependency
versions, sanitized settings, diagnostic JSON, and redacted logs. Database and
WAL files, task payload dumps, environment dumps, screenshots, credentials,
full aliases, and arbitrary cache files must never appear. Every exported byte
passes through the redactor so a registered sentinel cannot survive into the
archive.
"""

from __future__ import annotations

import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

import pytest
from pydantic import TypeAdapter

from hubfetch.config.settings import (
    AuthSource,
    Locale,
    ProxyMode,
    Settings,
    TaskKind,
    Theme,
)
from hubfetch.diagnostics.support_bundle import (
    MAX_LOG_MEMBER_BYTES,
    SupportBundleBuilder,
    SupportBundleError,
    contains_secret,
)
from hubfetch.security.redaction import Redactor, SecretRegistry

SENTINEL: Final = "hf_test_secret_123"

_SETTINGS_PAYLOAD_ADAPTER: Final = TypeAdapter(dict[str, object])
"""Typed JSON parser for the sanitized settings member."""


def _make_settings() -> Settings:
    """Build one non-secret settings fixture spanning every editable field."""
    return Settings(
        locale=Locale.EN_US,
        theme=Theme.DARK,
        proxy_mode=ProxyMode.MANUAL,
        manual_proxy_url="http://127.0.0.1:7897",
        default_auth_source=AuthSource.MANUAL,
        default_destinations={
            TaskKind.MODEL: Path("/data/models"),
            TaskKind.CLONE: Path("/data/clones"),
        },
        help_url="https://example.com/releases",
    )


def _fixed_clock() -> datetime:
    """Deterministic clock so two builds produce byte-identical archives."""
    return datetime(2026, 8, 15, 12, 0, 0, tzinfo=UTC)


def _write_log_dir(root: Path) -> Path:
    """Create a log directory full of allowlisted and excluded neighbors."""
    log_dir = root / "logs"
    log_dir.mkdir(parents=True)
    _ = (log_dir / "app.jsonl").write_text('{"event": "ready"}\n', encoding="utf-8")
    _ = (log_dir / "worker.log").write_text("transfer started\n", encoding="utf-8")
    _ = (log_dir / "hubfetch.db").write_bytes(b"sqlite-bytes")
    _ = (log_dir / "hubfetch.db-wal").write_bytes(b"wal-bytes")
    _ = (log_dir / "hubfetch.db-shm").write_bytes(b"shm-bytes")
    _ = (log_dir / "task.payload.json").write_text(
        '{"payload": true}', encoding="utf-8"
    )
    _ = (log_dir / "environment-dump.json").write_text(
        '{"env": "dump"}', encoding="utf-8"
    )
    _ = (log_dir / "screenshot.png").write_bytes(b"\x89PNG\r\n")
    _ = (log_dir / "cache_blob.bin").write_bytes(b"\x00\x01\x02")
    return log_dir


def test_archive_contains_exactly_the_typed_allowlist(
    tmp_path: Path,
) -> None:
    """Given database/WAL/payload/screenshot/binary neighbors, When exporting,
    Then only versions, settings, diagnostics, and allowlisted logs appear."""
    target = tmp_path / "bundle.zip"
    builder = SupportBundleBuilder(Redactor(), clock=_fixed_clock)
    result = builder.build(
        target=target,
        settings=_make_settings(),
        diagnostics={"storage": {"free_bytes": 123456}},
        log_dir=_write_log_dir(tmp_path),
    )

    assert result.errors == ()
    assert result.member_count == 5
    with zipfile.ZipFile(target) as archive:
        names = set(archive.namelist())
    assert names == {
        "versions.json",
        "settings.json",
        "diagnostics.json",
        "logs/app.jsonl",
        "logs/worker.log",
    }


def test_excluded_neighbors_never_reach_archive_bytes(tmp_path: Path) -> None:
    """Given excluded files beside logs, When exporting, Then no excluded bytes
    appear anywhere in the archive."""
    target = tmp_path / "bundle.zip"
    log_dir = _write_log_dir(tmp_path)
    builder = SupportBundleBuilder(Redactor(), clock=_fixed_clock)
    _ = builder.build(
        target=target,
        settings=_make_settings(),
        diagnostics={},
        log_dir=log_dir,
    )

    raw = target.read_bytes()
    assert b"sqlite-bytes" not in raw
    assert b"wal-bytes" not in raw
    assert b"shm-bytes" not in raw
    assert b"payload" not in raw
    assert b"\x89PNG" not in raw


def test_registered_sentinel_is_absent_from_archive_bytes_and_listing(
    tmp_path: Path,
    hf_test_secret: str,
) -> None:
    """Given a registered sentinel inside logs and diagnostics, When exporting,
    Then the sentinel never appears in member names or any member bytes."""
    registry = SecretRegistry()
    registry.register(hf_test_secret)
    redactor = Redactor(registry=registry)
    target = tmp_path / "bundle.zip"
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    _ = (log_dir / "app.jsonl").write_text(
        f"token={hf_test_secret} attached\n", encoding="utf-8"
    )
    builder = SupportBundleBuilder(
        redactor,
        clock=_fixed_clock,
        leak_guard=registry.registered_values,
    )
    _ = builder.build(
        target=target,
        settings=_make_settings(),
        diagnostics={"secret_value": hf_test_secret},
        log_dir=log_dir,
    )

    assert not contains_secret(target, hf_test_secret)
    raw = target.read_bytes()
    assert hf_test_secret.encode("utf-8") not in raw
    with zipfile.ZipFile(target) as archive:
        for member in archive.namelist():
            assert hf_test_secret not in member


def test_denied_export_path_raises_typed_error(tmp_path: Path) -> None:
    """Given a target whose parent does not exist, When exporting, Then a typed
    SupportBundleError is raised and no archive is produced."""
    target = tmp_path / "missing" / "bundle.zip"
    builder = SupportBundleBuilder(Redactor(), clock=_fixed_clock)
    log_dir = _write_log_dir(tmp_path)

    with pytest.raises(SupportBundleError):
        _ = builder.build(
            target=target,
            settings=_make_settings(),
            diagnostics={},
            log_dir=log_dir,
        )
    assert not target.exists()


def test_oversized_log_member_is_truncated_with_marker(tmp_path: Path) -> None:
    """Given a log larger than the member budget, When exporting, Then the
    archived member stays bounded and ends with the truncation marker."""
    target = tmp_path / "bundle.zip"
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    _ = (log_dir / "big.log").write_bytes(b"x" * (MAX_LOG_MEMBER_BYTES * 2))
    builder = SupportBundleBuilder(Redactor(), clock=_fixed_clock)
    _ = builder.build(
        target=target,
        settings=_make_settings(),
        diagnostics={},
        log_dir=log_dir,
    )

    with zipfile.ZipFile(target) as archive:
        member = archive.read("logs/big.log")
    assert len(member) <= MAX_LOG_MEMBER_BYTES + 128
    assert b"truncated for support bundle" in member


def test_unreadable_log_reports_typed_error_and_continues(
    tmp_path: Path,
) -> None:
    """Given one log the reader cannot open, When exporting, Then the failure is
    recorded as a typed error while the remaining allowlisted logs export."""
    target = tmp_path / "bundle.zip"
    log_dir = _write_log_dir(tmp_path)
    denied_reason = "simulated denied read"

    def failing_reader(path: Path) -> str:
        if path.name == "app.jsonl":
            raise OSError(denied_reason)
        return path.read_text(encoding="utf-8")

    builder = SupportBundleBuilder(
        Redactor(), clock=_fixed_clock, read_log=failing_reader
    )
    result = builder.build(
        target=target,
        settings=_make_settings(),
        diagnostics={},
        log_dir=log_dir,
    )

    assert any("app.jsonl" in error for error in result.errors)
    with zipfile.ZipFile(target) as archive:
        names = set(archive.namelist())
    assert "logs/worker.log" in names
    assert "logs/app.jsonl" not in names


def test_settings_member_is_sanitized_json_without_secrets(tmp_path: Path) -> None:
    """Given non-secret settings, When exporting, Then the settings member is
    parseable JSON with the expected sanitized values and no credential keys."""
    target = tmp_path / "bundle.zip"
    builder = SupportBundleBuilder(Redactor(), clock=_fixed_clock)
    _ = builder.build(
        target=target,
        settings=_make_settings(),
        diagnostics={},
        log_dir=_write_log_dir(tmp_path),
    )

    with zipfile.ZipFile(target) as archive:
        raw_payload = archive.read("settings.json").decode("utf-8")
    payload = _SETTINGS_PAYLOAD_ADAPTER.validate_json(raw_payload)
    assert payload["proxy_mode"] == "manual"
    assert payload["help_url"] == "https://example.com/releases"
    assert "token" not in payload
    assert "password" not in payload


def test_rebuild_with_fixed_clock_is_byte_identical(tmp_path: Path) -> None:
    """Given the same inputs and a fixed clock, When exporting twice, Then the
    archives are byte-identical (deterministic evidence)."""
    first = tmp_path / "first.zip"
    second = tmp_path / "second.zip"
    builder = SupportBundleBuilder(Redactor(), clock=_fixed_clock)
    log_dir = _write_log_dir(tmp_path)
    _ = builder.build(
        target=first,
        settings=_make_settings(),
        diagnostics={"storage": {"free_bytes": 1}},
        log_dir=log_dir,
    )
    _ = builder.build(
        target=second,
        settings=_make_settings(),
        diagnostics={"storage": {"free_bytes": 1}},
        log_dir=log_dir,
    )

    assert first.read_bytes() == second.read_bytes()
