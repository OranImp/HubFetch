"""Stable named events and redacted support-bundle models."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, TypedDict

from hubfetch.security.redaction import JsonValue

from .exceptions import InvalidEventNameError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from hubfetch.security.redaction import Redactor

EventLevel = Literal["debug", "info", "warn", "error"]
"""Supported event levels, ordered by consumer visibility."""

type EventValue = JsonValue
"""JSON-safe values allowed inside one event's typed fields."""

EVENT_SINK_OPENED: Final = "logging.sink.opened"
"""Emitted when a structured logging pipeline becomes ready."""

EVENT_SINK_FAILED: Final = "logging.sink.failed"
"""Emitted on the last-resort channel when a primary sink fails."""

_EVENT_NAME_PATTERN: Final = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")


def validate_event_name(name: str) -> str:
    """Return a name that satisfies the stable dotted event-name contract."""
    if not _EVENT_NAME_PATTERN.fullmatch(name):
        raise InvalidEventNameError(
            name=name, reason="event names are lowercase dotted identifiers"
        )
    return name


class SupportEvent(TypedDict):
    """Redacted, JSON-safe record written to the support-bundle JSONL sink."""

    timestamp: str
    level: EventLevel
    event: str
    message: str
    fields: dict[str, JsonValue]
    correlation_id: str | None


@dataclass(frozen=True, slots=True)
class Event:
    """One typed diagnostic event captured at a decision point."""

    name: str
    level: EventLevel
    timestamp: str
    message: str
    fields: Mapping[str, EventValue]
    correlation_id: str | None = None

    def __post_init__(self) -> None:
        """Validate the stable event-name contract at construction time."""
        _ = validate_event_name(self.name)

    def to_support(self, redactor: Redactor) -> SupportEvent:
        """Return the redacted support-bundle record for this event."""
        return {
            "timestamp": self.timestamp,
            "level": self.level,
            "event": self.name,
            "message": redactor.redact_text(self.message),
            "fields": redactor.redact_fields(self.fields),
            "correlation_id": (
                redactor.redact_text(self.correlation_id)
                if self.correlation_id is not None
                else None
            ),
        }
