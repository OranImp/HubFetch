"""Tests for the ordered, idempotent, fail-closed SQL migration runner."""

from __future__ import annotations

import sqlite3
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import (
    SCHEMA_VERSION,
    UnsupportedSchemaVersionError,
    current_schema_version,
    migrate,
)

if TYPE_CHECKING:
    from pathlib import Path

EXPECTED_TABLES: Final = frozenset(
    {"schema_version", "settings", "tasks", "task_transitions", "task_events"}
)


def _table_names(connection: sqlite3.Connection) -> frozenset[str]:
    """Return the names of every table in the schema."""
    rows: list[tuple[str]] = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).fetchall()
    return frozenset(name for (name,) in rows)


def test_fresh_database_migrates_to_current_schema(database_path: Path) -> None:
    """Given an empty database file, migration creates the full schema."""
    connection = open_connection(database_path)

    migrate(connection)

    assert current_schema_version(connection) == SCHEMA_VERSION
    assert _table_names(connection) >= EXPECTED_TABLES
    connection.close()


def test_migrate_is_idempotent(connection: sqlite3.Connection) -> None:
    """Given an already migrated database, a second migration is a no-op."""
    migrate(connection)

    assert current_schema_version(connection) == SCHEMA_VERSION
    assert _table_names(connection) >= EXPECTED_TABLES


def test_schema_survives_reopen(database_path: Path) -> None:
    """Given a migrated and closed database, reopening keeps the schema."""
    connection = open_connection(database_path)
    migrate(connection)
    connection.close()

    reopened = open_connection(database_path)
    migrate(reopened)

    assert current_schema_version(reopened) == SCHEMA_VERSION
    assert _table_names(reopened) >= EXPECTED_TABLES
    reopened.close()


def test_newer_schema_fails_closed(database_path: Path) -> None:
    """Given a database claiming a newer schema, migration refuses to run."""
    connection = open_connection(database_path)
    _ = connection.execute(
        "CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)"  # noqa: E501
    )
    _ = connection.execute(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
        (SCHEMA_VERSION + 1, "2026-01-01T00:00:00+00:00"),
    )
    connection.close()

    connection = open_connection(database_path)
    with pytest.raises(UnsupportedSchemaVersionError):
        migrate(connection)

    assert not {"tasks", "settings"} <= _table_names(connection)
    connection.close()


def test_failed_migration_rolls_back_everything(database_path: Path) -> None:
    """Given a conflicting table, a failed migration commits nothing."""
    connection = open_connection(database_path)
    _ = connection.execute("CREATE TABLE tasks (broken INTEGER)")
    connection.close()

    connection = open_connection(database_path)
    with pytest.raises(sqlite3.OperationalError):
        migrate(connection)

    assert current_schema_version(connection) is None
    assert "task_events" not in _table_names(connection)
    connection.close()

    connection = open_connection(database_path)
    _ = connection.execute("DROP TABLE tasks")
    connection.close()

    connection = open_connection(database_path)
    migrate(connection)
    assert current_schema_version(connection) == SCHEMA_VERSION
    connection.close()
