"""Read-only directory probes: writability, symlinks, and safe size scans."""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final

PROBE_DIR_PREFIX: Final = ".hubfetch-probe-"
"""Prefix that identifies probe temp directories so they are never mistaken
for user data and are always cleaned up."""

SYMLINK_RECOVERY_HINT: Final = (
    "Symlink creation needs Windows Developer Mode or an elevated process. "
    "HubFetch does not request elevation or change system policy; enable "
    "Developer Mode in Windows Settings so cached files can be deduplicated."
)
"""Display-only guidance for degraded symlink capability (never auto-applied)."""

_scandir = os.scandir
"""Module-level scandir alias so read-only scans can be monkeypatched in tests."""


@dataclass(frozen=True, slots=True)
class DirectoryProbe:
    """Typed result of probing one directory for write and symlink support."""

    target: Path
    probe_dir: Path | None
    writable: bool
    symlink_capable: bool
    symlink_degraded: bool
    recovery_hint: str | None
    error: str | None


@dataclass(frozen=True, slots=True)
class DirectorySize:
    """Typed byte and file count for one directory without following links."""

    path: Path
    bytes_total: int | None
    file_count: int
    complete: bool
    error: str | None


def _probe_host(target: Path) -> Path:
    """Return the nearest existing directory ancestor on the target volume."""
    candidate = target
    while not candidate.is_dir():
        parent = candidate.parent
        if parent == candidate:
            break
        candidate = parent
    return candidate


def _create_probe_dir(host: Path) -> Path:
    """Create one uniquely named temporary probe directory under a host."""
    return Path(tempfile.mkdtemp(prefix=PROBE_DIR_PREFIX, dir=host))


def _probe_write(probe_dir: Path) -> tuple[bool, str | None]:
    """Try writing a small file inside the probe directory."""
    try:
        probe_file = probe_dir / "write.probe"
        with probe_file.open("wb") as handle:
            _ = handle.write(b"hubfetch-probe")
    except OSError as error:
        return False, str(error)
    return True, None


def _make_symlink(_probe_dir: Path, link: Path, target: Path) -> None:
    """Create one symlink inside the probe directory."""
    link.symlink_to(target)


def _probe_symlink(probe_dir: Path) -> tuple[bool, str | None]:
    """Try creating a symlink inside the probe directory."""
    probe_file = probe_dir / "write.probe"
    link = probe_dir / "link.probe"
    try:
        _make_symlink(probe_dir, link, probe_file)
    except OSError as error:
        return False, str(error)
    return True, None


def probe_directory(target: Path) -> DirectoryProbe:
    """Probe writability and symlink support on the target volume read-only.

    Writes and symlinks happen only inside a uniquely named temporary
    directory on the target volume, which is always removed afterwards. The
    target itself is never mutated. A failed probe never raises; it returns a
    typed partial result with the OS error and display-only recovery guidance.

    Args:
        target: The destination directory whose volume should be probed.

    Returns:
        A typed probe describing writability and symlink capability.
    """
    host = _probe_host(target)
    probe_dir: Path | None = None
    try:
        probe_dir = _create_probe_dir(host)
        writable, write_error = _probe_write(probe_dir)
        if writable:
            symlink_capable, symlink_error = _probe_symlink(probe_dir)
        else:
            symlink_capable = False
            symlink_error = None
        degraded = not symlink_capable
        return DirectoryProbe(
            target=target,
            probe_dir=probe_dir,
            writable=writable,
            symlink_capable=symlink_capable,
            symlink_degraded=degraded,
            recovery_hint=SYMLINK_RECOVERY_HINT if degraded else None,
            error=write_error or symlink_error,
        )
    except OSError as error:
        return DirectoryProbe(
            target=target,
            probe_dir=None,
            writable=False,
            symlink_capable=False,
            symlink_degraded=True,
            recovery_hint=SYMLINK_RECOVERY_HINT,
            error=str(error),
        )
    finally:
        if probe_dir is not None:
            shutil.rmtree(probe_dir, ignore_errors=True)


def directory_size(path: Path) -> DirectorySize:
    """Count bytes and files under a path without following any symlinks.

    Untrusted links are skipped rather than traversed, and any OS error during
    the scan yields an unknown size instead of a falsely precise number.

    Args:
        path: The directory to scan recursively.

    Returns:
        A typed size result that is either complete or unknown with an error.
    """
    total_bytes = 0
    file_count = 0
    try:
        with _scandir(path) as entries:
            for entry in entries:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    nested = directory_size(Path(entry.path))
                    if nested.bytes_total is None:
                        return DirectorySize(
                            path=path,
                            bytes_total=None,
                            file_count=0,
                            complete=False,
                            error=nested.error,
                        )
                    total_bytes += nested.bytes_total
                    file_count += nested.file_count
                else:
                    total_bytes += entry.stat(follow_symlinks=False).st_size
                    file_count += 1
    except OSError as error:
        return DirectorySize(
            path=path,
            bytes_total=None,
            file_count=0,
            complete=False,
            error=str(error),
        )
    return DirectorySize(
        path=path,
        bytes_total=total_bytes,
        file_count=file_count,
        complete=True,
        error=None,
    )
