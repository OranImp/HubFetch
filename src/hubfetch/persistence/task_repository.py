"""Transactional repository over the task, transition, and event tables.

Every mutating method runs inside one explicit transaction, so a task and
its initial ``queued`` transition and event are written atomically.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, final

from hubfetch.domain.events import (
    PersistedEvent,
    TaskQueuedEvent,
    TaskRecoveredEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
)
from hubfetch.domain.ids import AttemptId, TaskId, parse_attempt_id, parse_task_id
from hubfetch.domain.lifecycle import (
    LifecycleEvent,
    LifecycleState,
    TransferStage,
)
from hubfetch.domain.lifecycle import transition as apply_transition

from .connection import Clock, Transaction, encode_timestamp
from .records import (
    StateMismatchError,
    TaskNotFoundError,
    TaskRecord,
    TransitionRecord,
    insert_event,
    insert_transition,
    next_event_id,
    next_position,
    parse_event,
    require_attempt,
    task_from_row,
    transition_from_row,
)
from .sql import (
    INSERT_TASK_SQL,
    SELECT_ACTIVE_TASKS_SQL,
    SELECT_EVENT_PAYLOADS_SQL,
    SELECT_TASK_ORDER_SQL,
    SELECT_TASK_WHERE_SQL,
    SELECT_TRANSITIONS_SQL,
    UPDATE_TASK_STATE_SQL,
)

if TYPE_CHECKING:
    import sqlite3

    from hubfetch.domain.task_spec import TaskSpec

    from .records import TaskRow, TransitionRow


@final
class TaskRepository:
    """Single persistence boundary for tasks, transitions, and events."""

    _connection: sqlite3.Connection
    _clock: Clock

    def __init__(self, connection: sqlite3.Connection, *, clock: Clock) -> None:
        """Bind one repository to a connection and a deterministic clock."""
        self._connection = connection
        self._clock = clock

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Persist a task with its initial queued transition and event."""
        now = self._clock.now()
        with Transaction(self._connection):
            position = next_position(self._connection)
            _ = self._connection.execute(
                INSERT_TASK_SQL,
                (
                    task_id,
                    spec.model_dump_json(),
                    LifecycleState.QUEUED.value,
                    attempt_id,
                    position,
                    encode_timestamp(now),
                    encode_timestamp(now),
                ),
            )
            insert_transition(
                self._connection,
                TransitionRecord(
                    task_id=task_id,
                    attempt_id=attempt_id,
                    from_state=LifecycleState.QUEUED,
                    to_state=LifecycleState.QUEUED,
                    occurred_at=now,
                    event_kind=None,
                ),
            )
            queued_event = TaskQueuedEvent(
                event_id=next_event_id(self._connection, attempt_id, "task_queued"),
                task_id=task_id,
                attempt_id=attempt_id,
                occurred_at=now,
            )
            insert_event(self._connection, queued_event)
        return self._require(task_id)

    def transition(
        self,
        task_id: TaskId,
        *,
        expected_state: LifecycleState,
        event: LifecycleEvent,
    ) -> TaskRecord:
        """Compare-and-set a lifecycle transition plus its sanitized event.

        The domain table rejects illegal transitions; the guarded update
        raises a typed :class:`StateMismatchError` when the stored state
        changed underneath the caller.
        """
        target_state = apply_transition(expected_state, event)
        now = self._clock.now()
        with Transaction(self._connection):
            attempt_id = require_attempt(self._connection, task_id)
            cursor = self._connection.execute(
                UPDATE_TASK_STATE_SQL,
                (
                    target_state.value,
                    encode_timestamp(now),
                    task_id,
                    expected_state.value,
                ),
            )
            if cursor.rowcount == 0:
                raise StateMismatchError(task_id=task_id, expected=expected_state)
            insert_transition(
                self._connection,
                TransitionRecord(
                    task_id=task_id,
                    attempt_id=parse_attempt_id(attempt_id),
                    from_state=expected_state,
                    to_state=target_state,
                    occurred_at=now,
                    event_kind=event,
                ),
            )
            transition_event = TaskTransitionedEvent(
                event_id=next_event_id(
                    self._connection, attempt_id, "task_transitioned"
                ),
                task_id=task_id,
                attempt_id=parse_attempt_id(attempt_id),
                occurred_at=now,
                from_state=expected_state,
                to_state=target_state,
            )
            insert_event(self._connection, transition_event)
        return self._require(task_id)

    def record_progress(
        self,
        task_id: TaskId,
        *,
        attempt_id: AttemptId,
        stage: TransferStage,
        bytes_done: int,
        bytes_total: int,
    ) -> TransferProgressedEvent:
        """Persist one sanitized byte-progress event for a task attempt."""
        now = self._clock.now()
        progress_event = TransferProgressedEvent(
            event_id=next_event_id(self._connection, attempt_id, "transfer_progressed"),
            task_id=task_id,
            attempt_id=attempt_id,
            occurred_at=now,
            stage=stage,
            bytes_done=bytes_done,
            bytes_total=bytes_total,
        )
        with Transaction(self._connection):
            _ = require_attempt(self._connection, task_id)
            insert_event(self._connection, progress_event)
        return progress_event

    def list(self) -> tuple[TaskRecord, ...]:
        """Return every task in persisted FIFO queue order."""
        rows: list[TaskRow] = self._connection.execute(SELECT_TASK_ORDER_SQL).fetchall()
        return tuple(task_from_row(row) for row in rows)

    def get(self, task_id: TaskId) -> TaskRecord | None:
        """Return one task by identifier, or ``None`` when it does not exist."""
        rows: list[TaskRow] = self._connection.execute(
            SELECT_TASK_WHERE_SQL,
            (task_id,),
        ).fetchall()
        return task_from_row(rows[0]) if rows else None

    def history(self, task_id: TaskId) -> tuple[PersistedEvent, ...]:
        """Return every persisted event of a task in deterministic order."""
        rows: list[tuple[str]] = self._connection.execute(
            SELECT_EVENT_PAYLOADS_SQL,
            (task_id,),
        ).fetchall()
        return tuple(parse_event(payload) for (payload,) in rows)

    def transitions(self, task_id: TaskId) -> tuple[TransitionRecord, ...]:
        """Return every recorded lifecycle change in insertion order."""
        rows: list[TransitionRow] = self._connection.execute(
            SELECT_TRANSITIONS_SQL,
            (task_id,),
        ).fetchall()
        return tuple(transition_from_row(row) for row in rows)

    def recover_interrupted(self) -> tuple[TaskId, ...]:
        """Convert every active attempt to ``interrupted`` with one event each.

        Only ``running`` or ``cancelling`` rows are updated, so a second run
        finds nothing to recover and never duplicates events.
        """
        now = self._clock.now()
        active_rows: list[tuple[str, str]] = self._connection.execute(
            SELECT_ACTIVE_TASKS_SQL
        ).fetchall()
        recovered: list[TaskId] = []
        with Transaction(self._connection):
            for raw_task_id, raw_state in active_rows:
                from_state = LifecycleState(raw_state)
                attempt_id = require_attempt(
                    self._connection, parse_task_id(raw_task_id)
                )
                cursor = self._connection.execute(
                    UPDATE_TASK_STATE_SQL,
                    (
                        LifecycleState.INTERRUPTED.value,
                        encode_timestamp(now),
                        raw_task_id,
                        raw_state,
                    ),
                )
                if cursor.rowcount == 0:
                    continue
                insert_transition(
                    self._connection,
                    TransitionRecord(
                        task_id=parse_task_id(raw_task_id),
                        attempt_id=parse_attempt_id(attempt_id),
                        from_state=from_state,
                        to_state=LifecycleState.INTERRUPTED,
                        occurred_at=now,
                        event_kind=LifecycleEvent.INTERRUPTED,
                    ),
                )
                recovered_event = TaskRecoveredEvent(
                    event_id=next_event_id(
                        self._connection, attempt_id, "task_recovered"
                    ),
                    task_id=parse_task_id(raw_task_id),
                    attempt_id=parse_attempt_id(attempt_id),
                    occurred_at=now,
                    from_state=from_state,
                )
                insert_event(self._connection, recovered_event)
                recovered.append(parse_task_id(raw_task_id))
        return tuple(recovered)

    def _require(self, task_id: TaskId) -> TaskRecord:
        record = self.get(task_id)
        if record is None:
            raise TaskNotFoundError(task_id=task_id)
        return record
