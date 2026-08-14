"""Branded identifiers shared by every HubFetch domain and wire model.

Each identifier is a ``NewType`` over ``str`` so the type system refuses to
mix a task identifier with an event identifier even though both are strings
at runtime. Parsing helpers exist for the few boundaries that receive raw
identifiers; Pydantic wire models accept the branded values directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import NewType, override

TaskId = NewType("TaskId", str)
AttemptId = NewType("AttemptId", str)
EventId = NewType("EventId", str)
RepositoryId = NewType("RepositoryId", str)


@dataclass(frozen=True, slots=True)
class InvalidIdentifierError(ValueError):
    """A branded identifier failed the boundary format contract."""

    id_kind: str
    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid {self.id_kind}: {self.reason}"


def _validate(raw: str, id_kind: str) -> str:
    """Reject empty identifiers and embedded NUL characters."""
    if not raw:
        raise InvalidIdentifierError(id_kind=id_kind, reason="identifier is empty")
    if "\x00" in raw:
        raise InvalidIdentifierError(id_kind=id_kind, reason="NUL is not allowed")
    return raw


def parse_task_id(raw: str) -> TaskId:
    """Parse and brand a task identifier at a raw boundary."""
    return TaskId(_validate(raw, "task id"))


def parse_attempt_id(raw: str) -> AttemptId:
    """Parse and brand an attempt identifier at a raw boundary."""
    return AttemptId(_validate(raw, "attempt id"))


def parse_event_id(raw: str) -> EventId:
    """Parse and brand an event identifier at a raw boundary."""
    return EventId(_validate(raw, "event id"))


def parse_repository_id(raw: str) -> RepositoryId:
    """Parse and brand a repository identifier at a raw boundary."""
    return RepositoryId(_validate(raw, "repository id"))
