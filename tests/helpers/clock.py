"""Deterministic clocks for tests that must not read wall-clock time."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Final, Protocol, final

DEFAULT_START: Final = datetime(2026, 1, 1, tzinfo=UTC)


class Clock(Protocol):
    """Expose the clock capability consumed by code under test."""

    def now(self) -> datetime:
        """Return the current deterministic instant."""
        ...


@final
class ControllableClock:
    """Provide an explicitly controlled, mutable test clock."""

    __slots__: Final = ("_current",)
    _current: datetime

    def __init__(self, start: datetime = DEFAULT_START) -> None:
        self._current = start

    def now(self) -> datetime:
        """Return the current controlled instant."""
        return self._current

    def set(self, value: datetime) -> None:
        """Set the controlled instant to a known value."""
        self._current = value

    def advance(self, delta: timedelta) -> datetime:
        """Advance the controlled instant and return the new value."""
        self._current += delta
        return self._current
