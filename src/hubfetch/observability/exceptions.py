"""Typed errors for the HubFetch observability pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from typing import override


class ObservabilityError(Exception):
    """Base class for errors raised by the observability subsystem."""


@dataclass(frozen=True, slots=True)
class InvalidEventNameError(ObservabilityError):
    """An event name violates the stable lowercase dotted contract."""

    name: str
    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid event name {self.name!r}: {self.reason}"


@dataclass(frozen=True, slots=True)
class InvalidLogLevelError(ObservabilityError):
    """A logger threshold is not one of the supported event levels."""

    level: str

    @override
    def __str__(self) -> str:
        return f"unsupported log level {self.level!r}"
