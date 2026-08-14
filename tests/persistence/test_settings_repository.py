"""Tests for versioned settings persistence through the config boundary."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from hubfetch.config.bootstrap import (
    InvalidSchemaVersionError,
    SettingsValidationError,
)
from hubfetch.config.settings import Locale, Settings
from hubfetch.persistence.settings_repository import SettingsRepository

if TYPE_CHECKING:
    import sqlite3

    from tests.helpers.clock import ControllableClock


def test_load_returns_none_when_unset(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given no stored settings, loading returns ``None``."""
    repository = SettingsRepository(connection, clock=clock)

    assert repository.load() is None


def test_save_then_load_round_trips(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given saved settings, loading returns an equivalent model."""
    repository = SettingsRepository(connection, clock=clock)
    settings = Settings()

    repository.save(settings)

    assert repository.load() == settings


def test_save_overwrites_previous_value(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given two saves, the newer value wins."""
    repository = SettingsRepository(connection, clock=clock)
    repository.save(Settings(locale=Locale.EN_US))

    repository.save(Settings(locale=Locale.ZH_CN))

    loaded = repository.load()
    assert loaded is not None
    assert loaded.locale == Locale.ZH_CN


def test_newer_schema_version_fails_closed(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a payload with a newer schema version, loading fails closed."""
    _ = connection.execute(
        "INSERT INTO settings (id, payload, updated_at) VALUES (1, ?, ?)",
        ('{"schema_version": 99}', "2026-01-01T00:00:00+00:00"),
    )

    with pytest.raises(InvalidSchemaVersionError):
        _ = SettingsRepository(connection, clock=clock).load()


def test_corrupt_payload_raises_typed_error(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a non-JSON payload, loading raises a typed validation error."""
    _ = connection.execute(
        "INSERT INTO settings (id, payload, updated_at) VALUES (1, ?, ?)",
        ("{not json", "2026-01-01T00:00:00+00:00"),
    )

    with pytest.raises(SettingsValidationError):
        _ = SettingsRepository(connection, clock=clock).load()
