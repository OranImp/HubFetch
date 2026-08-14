"""Immutable queue and task-detail snapshots for UI-facing consumers.

The scheduler and application service expose read-only views of the
transactional store through these frozen value objects, so Qt models can
observe state changes without any UI import reaching the domain services.
Snapshots are rebuilt from persisted records on every read; they never cache
or mutate application state.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from hubfetch.domain.lifecycle import LifecycleState

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime

    from hubfetch.domain.events import PersistedEvent
    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.persistence.records import TaskRecord, TransitionRecord

ACTIVE_STATES: frozenset[LifecycleState] = frozenset(
    {LifecycleState.RUNNING, LifecycleState.CANCELLING}
)
"""Lifecycle states that occupy the single active worker slot."""


@dataclass(frozen=True, slots=True)
class TaskSnapshot:
    """One immutable row of the transfer queue ledger."""

    task_id: TaskId
    attempt_id: AttemptId
    state: LifecycleState
    spec: TaskSpec
    position: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class QueueSnapshot:
    """An immutable FIFO view of every persisted task."""

    tasks: tuple[TaskSnapshot, ...]

    @property
    def active(self) -> tuple[TaskSnapshot, ...]:
        """Return the tasks occupying the single active worker slot."""
        return tuple(task for task in self.tasks if task.state in ACTIVE_STATES)

    @property
    def queued(self) -> tuple[TaskSnapshot, ...]:
        """Return the tasks still waiting to be claimed, in FIFO order."""
        return tuple(task for task in self.tasks if task.state == LifecycleState.QUEUED)

    @property
    def active_count(self) -> int:
        """Return how many tasks are active (at most one by design)."""
        return len(self.active)


@dataclass(frozen=True, slots=True)
class DetailSnapshot:
    """An immutable per-task view of identity, history, and events."""

    task: TaskSnapshot
    transitions: tuple[TransitionRecord, ...]
    events: tuple[PersistedEvent, ...]


def to_task_snapshot(record: TaskRecord) -> TaskSnapshot:
    """Map one persisted record into its immutable snapshot value."""
    return TaskSnapshot(
        task_id=record.task_id,
        attempt_id=record.attempt_id,
        state=record.state,
        spec=record.spec,
        position=record.position,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def queue_snapshot(records: Sequence[TaskRecord]) -> QueueSnapshot:
    """Build the immutable queue view from records already in FIFO order."""
    return QueueSnapshot(tasks=tuple(to_task_snapshot(record) for record in records))


def detail_snapshot(
    record: TaskRecord,
    transitions: Sequence[TransitionRecord],
    events: Sequence[PersistedEvent],
) -> DetailSnapshot:
    """Build the immutable detail view of one task."""
    return DetailSnapshot(
        task=to_task_snapshot(record),
        transitions=tuple(transitions),
        events=tuple(events),
    )
