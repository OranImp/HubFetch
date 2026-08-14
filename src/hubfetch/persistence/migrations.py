"""Ordered, idempotent SQL migrations for the HubFetch persistence store.

Migrations are plain files under ``sql/`` executed inside one explicit
transaction by :func:`migrate`.  The runner never interpolates values into
the scripts and fails closed when it meets a schema version newer than the
code understands, so an older build can never mutate a newer database.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, override

from .connection import Transaction

if TYPE_CHECKING:
    import sqlite3

SCHEMA_VERSION: Final = 1
"""The highest schema version this build can migrate to."""

_MIGRATION_DIR: Final = Path(__file__).with_name("sql")
_MIGRATION_FILES: Final = ("001_initial.sql",)

_SCHEMA_TABLE_COUNT_SQL: Final = "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"  # noqa: E501
_SCHEMA_VERSION_SQL: Final = (
    "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
)


@dataclass(frozen=True, slots=True)
class UnsupportedSchemaVersionError(ValueError):
    """A database claims a schema version newer than this build supports."""

    received: int
    supported: int

    @override
    def __str__(self) -> str:
        return (
            f"unsupported database schema version {self.received}; "
            f"supported up to {self.supported}"
        )


def _split_statements(script: str) -> tuple[str, ...]:
    """Split one migration script into complete statements at line ends.

    Comment lines are dropped and each statement is accumulated until a
    trailing semicolon.  The controlled migration scripts never contain a
    semicolon inside a literal, so this splitting is exact for them.
    """
    statements: list[str] = []
    current: list[str] = []
    for line in script.splitlines():
        if line.strip().startswith("--"):
            continue
        current.append(line)
        if line.rstrip().endswith(";"):
            statements.append("\n".join(current))
            current = []
    if current:
        message = "migration script must end each statement with a semicolon"
        raise ValueError(message)
    return tuple(statements)


def _load_migration_statements() -> tuple[str, ...]:
    """Load the ordered migration scripts as individual SQL statements."""
    statements: list[str] = []
    for filename in _MIGRATION_FILES:
        script = (_MIGRATION_DIR / filename).read_text(encoding="utf-8")
        statements.extend(_split_statements(script))
    return tuple(statements)


_MIGRATION_STATEMENTS: Final = _load_migration_statements()


def current_schema_version(connection: sqlite3.Connection) -> int | None:
    """Return the persisted schema version, or ``None`` for a fresh database."""
    rows: list[tuple[int]] = connection.execute(_SCHEMA_TABLE_COUNT_SQL).fetchall()
    if not rows or rows[0][0] == 0:
        return None
    version_rows: list[tuple[int]] = connection.execute(_SCHEMA_VERSION_SQL).fetchall()
    return version_rows[0][0] if version_rows else None


def migrate(connection: sqlite3.Connection) -> None:
    """Bring a database to the current schema, failing closed on newer ones.

    A fresh database runs every ordered script inside one transaction.  A
    database already at the current version is left untouched, and a database
    claiming a newer version raises :class:`UnsupportedSchemaVersionError`
    before any statement executes.
    """
    current = current_schema_version(connection)
    if current is not None and current > SCHEMA_VERSION:
        raise UnsupportedSchemaVersionError(
            received=current,
            supported=SCHEMA_VERSION,
        )
    if current == SCHEMA_VERSION:
        return
    with Transaction(connection):
        for statement in _MIGRATION_STATEMENTS:
            _ = connection.execute(statement)
