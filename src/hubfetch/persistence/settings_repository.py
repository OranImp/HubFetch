"""Versioned persistence of application settings through the Todo 2 boundary.

Settings are stored as one canonical JSON payload row and parsed on load
exclusively through :func:`parse_settings`, so the schema-version gate and
strict field validation stay in the config layer where they are owned.  The
payload carries only non-credential preferences; credentials never enter the
settings table.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

from pydantic import TypeAdapter, ValidationError

from hubfetch.config.bootstrap import (
    SettingsErrorDetail,
    SettingsValidationError,
    parse_settings,
)
from hubfetch.config.settings import Settings, SettingsValue

from .connection import Clock, Transaction, encode_timestamp

if TYPE_CHECKING:
    import sqlite3

_SETTINGS_PAYLOAD_ADAPTER: Final[TypeAdapter[dict[str, SettingsValue]]] = TypeAdapter(
    dict[str, SettingsValue]
)
"""Canonical JSON parser for one persisted settings payload."""

_SELECT_SETTINGS_SQL: Final = "SELECT payload FROM settings WHERE id = 1"
_UPSERT_SETTINGS_SQL: Final = "INSERT INTO settings (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"  # noqa: E501


@final
class SettingsRepository:
    """Persist and load application settings as a single versioned row."""

    _connection: sqlite3.Connection
    _clock: Clock

    def __init__(self, connection: sqlite3.Connection, *, clock: Clock) -> None:
        """Bind one repository to a connection and a deterministic clock."""
        self._connection = connection
        self._clock = clock

    def load(self) -> Settings | None:
        """Return the persisted settings, or ``None`` when none are stored."""
        rows: list[tuple[str]] = self._connection.execute(
            _SELECT_SETTINGS_SQL
        ).fetchall()
        if not rows:
            return None
        return parse_settings(self._decode_payload(rows[0][0]))

    def save(self, settings: Settings) -> None:
        """Atomically store or replace the single settings row."""
        with Transaction(self._connection):
            _ = self._connection.execute(
                _UPSERT_SETTINGS_SQL,
                (settings.model_dump_json(), encode_timestamp(self._clock.now())),
            )

    def _decode_payload(self, raw: str) -> dict[str, SettingsValue]:
        try:
            return _SETTINGS_PAYLOAD_ADAPTER.validate_json(raw)
        except ValidationError as error:
            raise SettingsValidationError(
                details=(
                    SettingsErrorDetail(
                        field_name="payload",
                        code=error.errors()[0]["type"],
                    ),
                )
            ) from error
