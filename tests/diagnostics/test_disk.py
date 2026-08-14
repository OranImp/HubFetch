"""Tests for volume identification, free space, and space readiness."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

import hubfetch.diagnostics.disk as disk_module
from hubfetch.diagnostics.disk import (
    SpaceAssessment,
    VolumeInfo,
    assess_space,
    free_space,
    same_volume,
    volume_info,
    volume_of,
)


@dataclass(frozen=True, slots=True)
class FakeUsage:
    """Structural stand-in for the shutil.disk_usage named tuple."""

    total: int
    used: int
    free: int


def test_volume_of_returns_anchor_for_absolute_path(tmp_path: Path) -> None:
    """Given an absolute path, its volume anchor identifies the volume."""
    assert volume_of(tmp_path) == tmp_path.absolute().anchor
    assert volume_of(Path(tmp_path.anchor)) == tmp_path.anchor


@pytest.mark.windows
def test_volume_of_returns_drive_root_for_drive_style_path() -> None:
    """Given a drive-style absolute path, the drive root is the volume."""
    assert volume_of(Path("C:/models")) == "C:\\"
    assert volume_of(Path("D:\\data\\x")) == "D:\\"


def test_same_volume_true_for_identical_anchors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given the same volume anchor, paths are on one volume."""

    def fake_volume_of(_path: Path) -> str:
        return "C:\\"

    monkeypatch.setattr(disk_module, "volume_of", fake_volume_of)

    assert same_volume(Path("C:\\a"), Path("C:\\b")) is True


def test_same_volume_false_for_distinct_anchors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given distinct volume anchors, paths are on separate volumes."""

    def fake_volume_of(path: Path) -> str:
        return "C:\\" if "cache" in path.name else "D:\\"

    monkeypatch.setattr(disk_module, "volume_of", fake_volume_of)

    assert same_volume(Path("cache"), Path("dest")) is False


def test_free_space_returns_free_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Given a usage result, free space returns the free byte count."""

    def fake_usage(_path: Path) -> FakeUsage:
        return FakeUsage(total=100, used=40, free=60)

    monkeypatch.setattr(disk_module, "_disk_usage", fake_usage)

    assert free_space(Path("C:\\any")) == 60


def test_free_space_unknown_when_usage_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a failing usage call, free space is reported as unknown."""

    def fail(_path: Path) -> FakeUsage:
        message = "drive not ready"
        raise OSError(message)

    monkeypatch.setattr(disk_module, "_disk_usage", fail)

    assert free_space(Path("C:\\any")) is None


def test_volume_info_reports_total_and_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a usage result, volume info carries both byte counts."""

    def fake_usage(_path: Path) -> FakeUsage:
        return FakeUsage(total=1000, used=300, free=700)

    monkeypatch.setattr(disk_module, "_disk_usage", fake_usage)

    info = volume_info(Path("C:\\any"))

    assert info == VolumeInfo(volume="C:\\", total_bytes=1000, free_bytes=700)


def test_volume_info_unknown_when_usage_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a failing usage call, volume info is a typed partial result."""

    def fail(_path: Path) -> FakeUsage:
        message = "access denied"
        raise PermissionError(message)

    monkeypatch.setattr(disk_module, "_disk_usage", fail)

    info = volume_info(Path("C:\\any"))

    assert info == VolumeInfo(volume="C:\\", total_bytes=None, free_bytes=None)


def test_assess_space_sufficient_when_free_covers_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given enough free bytes, readiness is sufficient with no shortfall."""

    def fake_usage(_path: Path) -> FakeUsage:
        return FakeUsage(total=1000, used=200, free=800)

    monkeypatch.setattr(disk_module, "_disk_usage", fake_usage)

    assessment = assess_space(Path("C:\\dest"), required_bytes=500)

    assert assessment == SpaceAssessment(
        volume="C:\\",
        required_bytes=500,
        free_bytes=800,
        sufficient=True,
        shortfall_bytes=0,
    )


def test_assess_space_insufficient_reports_shortfall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given insufficient free bytes, readiness reports the exact shortfall."""

    def fake_usage(_path: Path) -> FakeUsage:
        return FakeUsage(total=1000, used=700, free=300)

    monkeypatch.setattr(disk_module, "_disk_usage", fake_usage)

    assessment = assess_space(Path("C:\\dest"), required_bytes=500)

    assert assessment.sufficient is False
    assert assessment.shortfall_bytes == 200


def test_assess_space_unknown_when_required_size_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given an unknown required size, readiness never claims sufficiency."""

    def fake_usage(_path: Path) -> FakeUsage:
        return FakeUsage(total=1000, used=0, free=1000)

    monkeypatch.setattr(disk_module, "_disk_usage", fake_usage)

    assessment = assess_space(Path("C:\\dest"), required_bytes=None)

    assert assessment.sufficient is None
    assert assessment.shortfall_bytes is None
    assert assessment.free_bytes == 1000


def test_assess_space_unknown_when_free_space_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given an unknown free byte count, readiness stays unknown."""

    def fail(_path: Path) -> FakeUsage:
        message = "drive not ready"
        raise OSError(message)

    monkeypatch.setattr(disk_module, "_disk_usage", fail)

    assessment = assess_space(Path("C:\\dest"), required_bytes=500)

    assert assessment.sufficient is None
    assert assessment.shortfall_bytes is None
    assert assessment.free_bytes is None


def test_assess_space_uses_destination_volume_for_free_space(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given a separate cache volume, readiness uses the destination volume."""

    def fake_usage(path: Path) -> FakeUsage:
        return FakeUsage(
            total=1000, used=0, free=900 if str(path).startswith("D") else 100
        )

    monkeypatch.setattr(disk_module, "_disk_usage", fake_usage)

    assessment = assess_space(Path("D:\\dest"), required_bytes=500)

    assert same_volume(Path("C:\\cache"), Path("D:\\dest")) is False
    assert assessment.volume == "D:\\"
    assert assessment.free_bytes == 900
    assert assessment.sufficient is True
