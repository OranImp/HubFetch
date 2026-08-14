"""SQLite connection factory with explicit transactions and typed errors.

The persistence layer owns a single transactional boundary: connections are
opened in autocommit mode with foreign keys enforced, WAL journaling, and a
busy timeout, and every multi-statement operation runs inside
:class:`Transaction`, which commits only when its body exits cleanly.  All
schema migration and repository logic is built on top of these primitives.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, Protocol, final, override

if TYPE_CHECKING:
    from pathlib import Path
    from types import TracebackType

BUSY_TIMEOUT_MS: Final = 5000
"""Milliseconds a writer waits for a concurrent writer to release the lock."""


class Clock(Protocol):
    """Expose the deterministic clock consumed by persistence timestamps."""

    def now(self) -> datetime:
        """Return the current instant as an aware UTC datetime."""
        ...


@dataclass(frozen=True, slots=True)
class ConnectionOpenError(ValueError):
    """A persistence database could not be opened at the configured path."""

    path: Path
    reason: str

    @override
    def __str__(self) -> str:
        return f"cannot open persistence database {self.path}: {self.reason}"


@dataclass(frozen=True, slots=True)
class TransactionError(ValueError):
    """A persistence transaction could not begin, commit, or roll back."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"persistence transaction failed: {self.reason}"


def encode_timestamp(instant: datetime) -> str:
    """Encode one instant as a canonical UTC ISO-8601 persistence value."""
    return instant.astimezone(UTC).isoformat()


def decode_timestamp(raw: str) -> datetime:
    """Decode one canonical UTC ISO-8601 persistence value."""
    return datetime.fromisoformat(raw)


def open_connection(database: Path) -> sqlite3.Connection:
    """Open one SQLite connection with the HubFetch persistence defaults.

    The connection runs in autocommit mode so every write belongs to an
    explicit :class:`Transaction`; foreign keys are always enforced, the
    journal is write-ahead logged, and the busy timeout prevents spurious
    lock failures during concurrent worker access.
    """
    database.parent.mkdir(parents=True, exist_ok=True)
    try:
        connection = sqlite3.connect(
            database,
            isolation_level=None,
            timeout=BUSY_TIMEOUT_MS / 1000,
        )
    except sqlite3.Error as error:
        raise ConnectionOpenError(path=database, reason=str(error)) from error
    _ = connection.execute("PRAGMA foreign_keys = ON")
    _ = connection.execute("PRAGMA busy_timeout = 5000")
    _ = connection.execute("PRAGMA journal_mode = WAL")
    return connection


@final
class Transaction:
    """Run the enclosed statements in one atomic persistence transaction.

    The transaction starts with an immediate write lock, commits only when
    the body exits without error, and rolls back on any exception.  A commit
    or rollback failure surfaces as a typed :class:`TransactionError`.
    """

    __slots__: Final = ("_connection",)
    _connection: sqlite3.Connection

    def __init__(self, connection: sqlite3.Connection) -> None:
        """Bind one transaction to a connection."""
        self._connection = connection

    def __enter__(self) -> None:
        """Acquire the immediate write lock for the transaction."""
        _ = self._connection.execute("BEGIN IMMEDIATE")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        _exc_value: BaseException | None,
        _traceback: TracebackType | None,
    ) -> bool:
        """Commit a clean body or roll back a failing one."""
        if exc_type is None:
            try:
                self._connection.commit()
            except sqlite3.Error as error:
                raise TransactionError(reason="cannot commit") from error
        else:
            try:
                self._connection.rollback()
            except sqlite3.Error as error:
                raise TransactionError(reason="cannot roll back") from error
        return False
