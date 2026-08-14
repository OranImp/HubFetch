"""Row values, parsing, and low-level statements of the task store.

This module owns the persisted row shapes and the pure functions that parse
them through the Todo 3 domain models, plus the small statement helpers the
repository uses inside its transactions.  Corrupted rows surface as a typed
:class:`CorruptRecordError` instead of raw parser noise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, override

from pydantic import TypeAdapter, ValidationError

from hubfetch.domain.events import PersistedEvent
from hubfetch.domain.ids import (
    AttemptId,
    EventId,
    TaskId,
    parse_attempt_id,
    parse_task_id,
)
from hubfetch.domain.lifecycle import LifecycleEvent, LifecycleState
from hubfetch.domain.task_spec import TaskSpec

from .connection import decode_timestamp, encode_timestamp
from .sql import (
    COUNT_EVENTS_SQL,
    INSERT_EVENT_SQL,
    INSERT_TRANSITION_SQL,
    SELECT_ATTEMPT_SQL,
    SELECT_MAX_POSITION_SQL,
)

if TYPE_CHECKING:
    import sqlite3
    from datetime import datetime

TASK_SPEC_ADAPTER: Final[TypeAdapter[TaskSpec]] = TypeAdapter(TaskSpec)
"""Canonical parser for the tagged task specification union."""

PERSISTED_EVENT_ADAPTER: Final[TypeAdapter[PersistedEvent]] = TypeAdapter(
    PersistedEvent
)
"""Canonical parser for the tagged persisted event union."""

TaskRow = tuple[str, str, str, str, int, str, str]
"""Positional shape of one ``tasks`` row: task_id, spec, state, attempt_id,
position, created_at, updated_at."""

TransitionRow = tuple[str, str, str, str, str, str | None]
"""Positional shape of one ``task_transitions`` row: task_id, attempt_id,
from_state, to_state, occurred_at, event_kind."""


@dataclass(frozen=True, slots=True)
class TaskRecord:
    """One persisted task with its current lifecycle state and queue order."""

    task_id: TaskId
    spec: TaskSpec
    state: LifecycleState
    attempt_id: AttemptId
    position: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class TransitionRecord:
    """One recorded lifecycle state change of a task attempt."""

    task_id: TaskId
    attempt_id: AttemptId
    from_state: LifecycleState
    to_state: LifecycleState
    occurred_at: datetime
    event_kind: LifecycleEvent | None


@dataclass(frozen=True, slots=True)
class TaskNotFoundError(ValueError):
    """A task identifier does not name a persisted task."""

    task_id: TaskId

    @override
    def __str__(self) -> str:
        return f"task {self.task_id} does not exist"


@dataclass(frozen=True, slots=True)
class StateMismatchError(ValueError):
    """The compare-and-set guard rejected a transition.

    The stored state differs from the caller's expected state.
    """

    task_id: TaskId
    expected: LifecycleState

    @override
    def __str__(self) -> str:
        return f"task {self.task_id} is not in state {self.expected.value}"


@dataclass(frozen=True, slots=True)
class CorruptRecordError(ValueError):
    """A stored row could not be parsed through its domain model."""

    table: str
    key: str
    reason: str

    @override
    def __str__(self) -> str:
        return f"corrupt {self.table} record {self.key}: {self.reason}"


def parse_spec(raw: str) -> TaskSpec:
    """Parse one persisted task specification through its domain model."""
    try:
        return TASK_SPEC_ADAPTER.validate_json(raw)
    except ValidationError as error:
        raise CorruptRecordError(
            table="tasks",
            key="spec",
            reason=str(error),
        ) from error


def parse_event(raw: str) -> PersistedEvent:
    """Parse one persisted event payload through its domain model."""
    try:
        return PERSISTED_EVENT_ADAPTER.validate_json(raw)
    except ValidationError as error:
        raise CorruptRecordError(
            table="task_events",
            key="payload",
            reason=str(error),
        ) from error


def task_from_row(row: TaskRow) -> TaskRecord:
    """Parse one persisted ``tasks`` row into a typed task record."""
    task_id, spec_json, state, attempt_id, position, created_at, updated_at = row
    return TaskRecord(
        task_id=parse_task_id(task_id),
        spec=parse_spec(spec_json),
        state=LifecycleState(state),
        attempt_id=parse_attempt_id(attempt_id),
        position=position,
        created_at=decode_timestamp(created_at),
        updated_at=decode_timestamp(updated_at),
    )


def transition_from_row(row: TransitionRow) -> TransitionRecord:
    """Parse one persisted ``task_transitions`` row into a typed record."""
    raw_task, attempt, from_state, to_state, occurred_at, event_kind = row
    return TransitionRecord(
        task_id=parse_task_id(raw_task),
        attempt_id=parse_attempt_id(attempt),
        from_state=LifecycleState(from_state),
        to_state=LifecycleState(to_state),
        occurred_at=decode_timestamp(occurred_at),
        event_kind=(LifecycleEvent(event_kind) if event_kind is not None else None),
    )


def next_position(connection: sqlite3.Connection) -> int:
    """Return the next FIFO queue position for a new task."""
    rows: list[tuple[int | None]] = connection.execute(
        SELECT_MAX_POSITION_SQL
    ).fetchall()
    current = rows[0][0] if rows else None
    return (current + 1) if current is not None else 1


def require_attempt(connection: sqlite3.Connection, task_id: TaskId) -> str:
    """Return the current attempt of a task, or fail when it does not exist."""
    rows: list[tuple[str]] = connection.execute(
        SELECT_ATTEMPT_SQL,
        (task_id,),
    ).fetchall()
    if not rows:
        raise TaskNotFoundError(task_id=task_id)
    return rows[0][0]


def next_event_id(
    connection: sqlite3.Connection, attempt_id: str, kind: str
) -> EventId:
    """Build the next unique event identifier for one attempt."""
    rows: list[tuple[int]] = connection.execute(
        COUNT_EVENTS_SQL,
        (attempt_id,),
    ).fetchall()
    count = rows[0][0] if rows else 0
    return EventId(f"{kind}-{attempt_id}-{count + 1}")


def insert_transition(
    connection: sqlite3.Connection,
    transition: TransitionRecord,
) -> None:
    """Insert one lifecycle transition row inside the current transaction."""
    _ = connection.execute(
        INSERT_TRANSITION_SQL,
        (
            transition.task_id,
            transition.attempt_id,
            transition.from_state.value,
            transition.to_state.value,
            encode_timestamp(transition.occurred_at),
            (
                transition.event_kind.value
                if transition.event_kind is not None
                else None
            ),
        ),
    )


def insert_event(connection: sqlite3.Connection, event: PersistedEvent) -> None:
    """Insert one sanitized event row inside the current transaction."""
    _ = connection.execute(
        INSERT_EVENT_SQL,
        (
            event.event_id,
            event.task_id,
            event.attempt_id,
            encode_timestamp(event.occurred_at),
            event.kind,
            event.model_dump_json() + "\n",
        ),
    )
