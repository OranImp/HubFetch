"""Shared persistence test fixtures over real temporary SQLite files."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from tests.helpers.clock import ControllableClock

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator
    from pathlib import Path


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    """Return the path of a fresh, empty SQLite database file."""
    return tmp_path / "hubfetch.db"


@pytest.fixture
def connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    """Return a migrated connection to a temporary database."""
    connection = open_connection(database_path)
    migrate(connection)
    yield connection
    connection.close()


@pytest.fixture
def clock() -> ControllableClock:
    """Return a deterministic clock advanced only by the test."""
    return ControllableClock()
