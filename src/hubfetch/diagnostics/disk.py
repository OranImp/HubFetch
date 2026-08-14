"""Volume identification, free-space measurement, and space readiness."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

_disk_usage = shutil.disk_usage
"""Module-level disk_usage alias so free-space reads can be controlled in tests."""


@dataclass(frozen=True, slots=True)
class VolumeInfo:
    """Byte counts for one volume identified by its anchor root."""

    volume: str
    total_bytes: int | None
    free_bytes: int | None


@dataclass(frozen=True, slots=True)
class SpaceAssessment:
    """Readiness of one volume for a planned transfer of known or unknown size."""

    volume: str
    required_bytes: int | None
    free_bytes: int | None
    sufficient: bool | None
    shortfall_bytes: int | None


def volume_of(path: Path) -> str:
    r"""Return the volume anchor root for a path (e.g. 'C:\\' on Windows)."""
    anchor = path.anchor
    if anchor:
        return anchor
    return path.absolute().anchor


def same_volume(left: Path, right: Path) -> bool:
    """Return whether two paths resolve to the same volume anchor."""
    return volume_of(left) == volume_of(right)


def _usage_root(path: Path) -> Path:
    """Return an existing anchor path whose free space covers the target."""
    anchor = volume_of(path)
    return Path(anchor) if anchor else path


def free_space(path: Path) -> int | None:
    """Return free bytes on the volume hosting a path, or None when unknown.

    A missing or unreadable volume yields None rather than a fabricated byte
    count, because a false zero could wrongly block or allow a transfer.

    Args:
        path: Any path on the volume whose free space is needed.

    Returns:
        Free bytes on the volume, or None when the volume cannot be queried.
    """
    try:
        usage = _disk_usage(_usage_root(path))
    except OSError:
        return None
    return usage.free


def volume_info(path: Path) -> VolumeInfo:
    """Return total and free bytes for the volume hosting a path.

    Args:
        path: Any path on the volume to measure.

    Returns:
        A typed volume result; byte counts are None when the volume is unknown.
    """
    try:
        usage = _disk_usage(_usage_root(path))
    except OSError:
        return VolumeInfo(volume=volume_of(path), total_bytes=None, free_bytes=None)
    return VolumeInfo(
        volume=volume_of(path),
        total_bytes=usage.total,
        free_bytes=usage.free,
    )


def assess_space(target: Path, required_bytes: int | None) -> SpaceAssessment:
    """Assess whether a planned transfer fits on the target's volume.

    The required size arrives from transfer planning dry-run data. When the
    required size or the free bytes are unknown, readiness stays unknown rather
    than claiming enough disk space.

    Args:
        target: The destination path whose volume hosts the transfer.
        required_bytes: Expected transfer bytes, or None when size is unknown.

    Returns:
        A typed readiness assessment for the affected volume.
    """
    free = free_space(target)
    if required_bytes is None or free is None:
        return SpaceAssessment(
            volume=volume_of(target),
            required_bytes=required_bytes,
            free_bytes=free,
            sufficient=None,
            shortfall_bytes=None,
        )
    if free >= required_bytes:
        return SpaceAssessment(
            volume=volume_of(target),
            required_bytes=required_bytes,
            free_bytes=free,
            sufficient=True,
            shortfall_bytes=0,
        )
    return SpaceAssessment(
        volume=volume_of(target),
        required_bytes=required_bytes,
        free_bytes=free,
        sufficient=False,
        shortfall_bytes=required_bytes - free,
    )
