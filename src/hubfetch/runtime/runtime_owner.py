"""Single-owner runtime acquisition for the FIFO scheduler.

Exactly one process may own the runtime at a time. The owner is a
non-blocking byte-range lock on a dedicated lock file beside the database;
the operating system releases that lock automatically when the owning
process exits, so a crashed runtime never leaves a stale lock behind. A
second runtime instance is refused with a typed error instead of silently
racing the first.
"""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol, final, override

try:
    import msvcrt as _windows_locking
except ImportError:  # pragma: no cover - product targets Windows
    _windows_locking = None

if TYPE_CHECKING:
    from pathlib import Path
    from typing import BinaryIO


@dataclass(frozen=True, slots=True)
class RuntimeOwnerUnavailableError(ValueError):
    """Another runtime instance already owns the transfer scheduler."""

    path: Path

    @override
    def __str__(self) -> str:
        return f"runtime owner is already held at {self.path}"


class RuntimeOwner(Protocol):
    """The single-owner contract the scheduler acquires at startup."""

    def acquire(self) -> None:
        """Become the runtime owner or raise a typed unavailable error."""
        ...

    def release(self) -> None:
        """Relinquish ownership so another process may acquire it."""
        ...


@final
class FileLockRuntimeOwner:
    """Byte-range-lock owner on a dedicated lock file beside the database."""

    __slots__: Final = ("_file", "_held", "_lock_path")
    _lock_path: Path
    _file: BinaryIO | None
    _held: bool

    def __init__(self, lock_path: Path) -> None:
        """Bind one owner to its lock file; ownership is acquired later."""
        self._lock_path = lock_path
        self._file = None
        self._held = False

    def acquire(self) -> None:
        """Take the non-blocking exclusive lock or fail with a typed error.

        The lock file is kept open for the whole ownership window because
        closing the last handle would release the byte range on Windows.
        """
        if self._held:
            return
        if _windows_locking is None:
            raise RuntimeOwnerUnavailableError(path=self._lock_path)
        file = self._lock_path.open("a+b")
        try:
            _ = file.seek(0)
            _windows_locking.locking(file.fileno(), _windows_locking.LK_NBLCK, 1)
        except OSError as error:
            file.close()
            raise RuntimeOwnerUnavailableError(path=self._lock_path) from error
        self._file = file
        self._held = True

    def release(self) -> None:
        """Unlock and close the retained handle without ever raising."""
        if not self._held or self._file is None:
            return
        file = self._file
        self._file = None
        self._held = False
        with suppress(OSError):
            _ = file.seek(0)
            if _windows_locking is not None:
                _windows_locking.locking(file.fileno(), _windows_locking.LK_UNLCK, 1)
        file.close()

    @property
    def held(self) -> bool:
        """Return whether this process currently owns the runtime lock."""
        return self._held
