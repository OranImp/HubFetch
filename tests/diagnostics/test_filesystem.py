"""Tests for read-only filesystem probes: writability, symlinks, and size."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

import hubfetch.diagnostics.filesystem as filesystem_module
from hubfetch.diagnostics.filesystem import (
    DirectoryProbe,
    DirectorySize,
    directory_size,
    probe_directory,
)

if TYPE_CHECKING:
    from pathlib import Path

PROBE_PREFIX = ".hubfetch-probe-"


def test_probe_reports_writable_and_cleans_up(tmp_path: Path) -> None:
    """Given a writable target, the probe succeeds and removes its temp dir."""
    probe = probe_directory(tmp_path)

    assert isinstance(probe, DirectoryProbe)
    assert probe.writable is True
    assert probe.error is None
    assert probe.probe_dir is not None
    assert not probe.probe_dir.exists()
    leftovers = [entry.name for entry in tmp_path.iterdir()]
    assert not any(name.startswith(PROBE_PREFIX) for name in leftovers)


def test_probe_read_only_leaves_target_unchanged(tmp_path: Path) -> None:
    """Given a target with a sentinel file, probing mutates nothing inside it."""
    sentinel = tmp_path / "keep.txt"
    _ = sentinel.write_text("unchanged", encoding="utf-8")
    before = {entry.name for entry in tmp_path.iterdir()}

    _ = probe_directory(tmp_path)

    after = {entry.name for entry in tmp_path.iterdir()}
    assert after == before
    assert sentinel.read_text(encoding="utf-8") == "unchanged"


def test_probe_creates_unique_temp_dir_on_the_target_volume(
    tmp_path: Path,
) -> None:
    """Given a writable target, the probe temp dir is unique and removable."""
    first = probe_directory(tmp_path)
    second = probe_directory(tmp_path)

    assert first.probe_dir is not None
    assert second.probe_dir is not None
    assert first.probe_dir != second.probe_dir
    assert first.probe_dir.parent == tmp_path
    assert not first.probe_dir.exists()
    assert not second.probe_dir.exists()


def test_probe_nonexistent_target_uses_nearest_ancestor(tmp_path: Path) -> None:
    """Given a destination that does not exist, the probe walks to an ancestor."""
    target = tmp_path / "a" / "b" / "model"
    probe = probe_directory(target)

    assert probe.writable is True
    assert probe.probe_dir is not None
    assert probe.probe_dir.parent == tmp_path


def test_probe_denied_write_is_a_typed_partial_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Given a failing temp-dir creation, the probe reports a typed denial."""

    def deny(_target: Path) -> Path:
        message = "access denied"
        raise PermissionError(message)

    monkeypatch.setattr(filesystem_module, "_create_probe_dir", deny)

    probe = probe_directory(tmp_path)

    assert probe.writable is False
    assert probe.symlink_capable is False
    assert probe.error == "access denied"
    assert probe.recovery_hint is not None


def test_probe_symlink_degraded_is_a_typed_partial_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Given a failing symlink creation, the probe reports degradation."""

    def deny(_probe_dir: Path, _link: Path, _target: Path) -> None:
        raise OSError(1314, "A required privilege is not held")

    monkeypatch.setattr(filesystem_module, "_make_symlink", deny)

    probe = probe_directory(tmp_path)

    assert probe.writable is True
    assert probe.symlink_capable is False
    assert probe.symlink_degraded is True
    assert probe.recovery_hint is not None
    assert "Developer Mode" in (probe.recovery_hint or "")


def test_probe_symlink_capability_matches_os_capability(
    tmp_path: Path,
) -> None:
    """Given working OS symlinks, the probe must report capability."""
    link = tmp_path / "probe-link"
    try:
        link.symlink_to(tmp_path / "probe-target")
    except OSError:
        pytest.skip("symlink creation is unavailable in this environment")
    link.unlink()

    probe = probe_directory(tmp_path)

    assert probe.symlink_capable is True
    assert probe.symlink_degraded is False
    assert probe.recovery_hint is None


def test_directory_size_counts_bytes_recursively(tmp_path: Path) -> None:
    """Given nested files, the size scan sums all bytes without following links."""
    nested = tmp_path / "nested"
    nested.mkdir()
    _ = (nested / "inner.bin").write_bytes(b"x" * 10)
    _ = (tmp_path / "outer.bin").write_bytes(b"y" * 20)

    size = directory_size(tmp_path)

    assert isinstance(size, DirectorySize)
    assert size.complete is True
    assert size.bytes_total == 30
    assert size.file_count == 2


def test_directory_size_does_not_follow_symlinks(tmp_path: Path) -> None:
    """Given a symlink to a large file, its bytes are excluded from the total."""
    outside = tmp_path.parent / "outside-weights.bin"
    _ = outside.write_bytes(b"z" * 500)
    _ = (tmp_path / "real.bin").write_bytes(b"r" * 5)
    link = tmp_path / "link.bin"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation unavailable in this environment")

    size = directory_size(tmp_path)

    assert size.complete is True
    assert size.bytes_total == 5
    assert size.file_count == 1


def test_directory_size_unknown_when_scan_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Given an unreadable subdirectory, the size is reported as unknown."""

    def deny(_path: Path) -> object:
        message = "access denied"
        raise PermissionError(message)

    monkeypatch.setattr(filesystem_module, "_scandir", deny)

    size = directory_size(tmp_path)

    assert size.complete is False
    assert size.bytes_total is None
    assert size.error == "access denied"


def test_directory_size_empty_directory_is_zero(tmp_path: Path) -> None:
    """Given an empty directory, the scan reports zero bytes and completeness."""
    size = directory_size(tmp_path)

    assert size.complete is True
    assert size.bytes_total == 0
    assert size.file_count == 0
