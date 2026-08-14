"""Single-owner FIFO scheduler over the transactional task repository.

The scheduler is deliberately GUI-free. It owns startup recovery, the
diagnostics gate, oldest-queued selection, and the claim compare-and-set,
then reports through a tiny typed observer seam that Qt widgets bridge to
signals in the UI layer without any UI import reaching this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from threading import Lock
from typing import TYPE_CHECKING, Final, Protocol, final, override

from hubfetch.application.snapshots import (
    ACTIVE_STATES,
    detail_snapshot,
    queue_snapshot,
)
from hubfetch.domain.lifecycle import (
    LifecycleEvent,
    LifecycleState,
    is_terminal,
)
from hubfetch.domain.lifecycle import (
    transition as apply_transition,
)
from hubfetch.persistence.records import StateMismatchError, TaskNotFoundError

if TYPE_CHECKING:
    from hubfetch.application.snapshots import DetailSnapshot, QueueSnapshot
    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.persistence.records import TaskRecord
    from hubfetch.persistence.task_repository import TaskRepository
    from hubfetch.runtime.runtime_owner import RuntimeOwner


@unique
class DispatchBlockReason(StrEnum):
    """Reasons the scheduler refuses to dispatch before its gates open."""

    RECOVERY_PENDING = "recovery_pending"
    DIAGNOSTICS_PENDING = "diagnostics_pending"


class DispatchResult:
    """Base of the tagged outcome of one scheduler dispatch attempt."""


@dataclass(frozen=True, slots=True)
class DispatchBlocked(DispatchResult):
    """A hard ordering gate is still closed."""

    reason: DispatchBlockReason


@dataclass(frozen=True, slots=True)
class DispatchIdle(DispatchResult):
    """The queue is empty or the single active slot is occupied."""

    active_task_id: TaskId | None


@dataclass(frozen=True, slots=True)
class DispatchClaimed(DispatchResult):
    """The oldest queued task was claimed through a committed CAS."""

    task_id: TaskId
    attempt_id: AttemptId


@dataclass(frozen=True, slots=True)
class RecoveryReport:
    """Task identifiers converted to interrupted at this startup."""

    recovered: tuple[TaskId, ...]


@dataclass(frozen=True, slots=True)
class SchedulerAlreadyStartedError(ValueError):
    """Recovery may run exactly once per scheduler instance."""

    @override
    def __str__(self) -> str:
        return "the scheduler already started; recovery runs once"


@dataclass(frozen=True, slots=True)
class NonTerminalCompletionError(ValueError):
    """A completion event targeted a non-terminal lifecycle state."""

    task_id: TaskId
    target_state: LifecycleState

    @override
    def __str__(self) -> str:
        return (
            f"task {self.task_id} completion targets the non-terminal "
            f"state {self.target_state.value}"
        )


class SchedulerObserver(Protocol):
    """Typed notification seam the UI layer bridges to Qt signals."""

    def task_started(self, task_id: TaskId, attempt_id: AttemptId) -> None:
        """A queued task was claimed and a worker may now be launched."""
        ...

    def queue_changed(self) -> None:
        """The persisted queue changed and views should take a new snapshot."""
        ...


@final
class Scheduler:
    """Dispatch the oldest queued task once ownership and gates allow."""

    __slots__: Final = (
        "_diagnostics_ready",
        "_lock",
        "_observer",
        "_owner",
        "_recovery_done",
        "_repository",
        "_started",
    )
    _repository: TaskRepository
    _owner: RuntimeOwner
    _observer: SchedulerObserver | None
    _lock: Lock
    _recovery_done: bool
    _diagnostics_ready: bool
    _started: bool

    def __init__(
        self,
        repository: TaskRepository,
        *,
        owner: RuntimeOwner,
        observer: SchedulerObserver | None = None,
    ) -> None:
        """Bind the scheduler to its repository, owner, and observer."""
        self._repository = repository
        self._owner = owner
        self._observer = observer
        self._lock = Lock()
        self._recovery_done = False
        self._diagnostics_ready = False
        self._started = False

    def start(self) -> RecoveryReport:
        """Acquire ownership and recover interrupted tasks exactly once.

        Ownership is taken before any recovery so a second runtime instance
        is refused before it can touch the store. No task is claimed here:
        dispatch is a separate, explicit step that stays blocked until the
        recovery and diagnostics gates both complete.
        """
        with self._lock:
            if self._started:
                raise SchedulerAlreadyStartedError
            self._owner.acquire()
            self._started = True
            recovered = self._repository.recover_interrupted()
            self._recovery_done = True
        self._notify_queue_changed()
        return RecoveryReport(recovered=recovered)

    def close(self) -> None:
        """Release the runtime owner so another process may take over."""
        with self._lock:
            if not self._started:
                return
            self._started = False
            self._owner.release()

    def mark_diagnostics_ready(self) -> None:
        """Open the diagnostics gate; dispatch remains an explicit step."""
        with self._lock:
            self._diagnostics_ready = True

    def dispatch(self) -> DispatchResult:
        """Attempt to claim the oldest queued task through one repository CAS.

        Hard ordering: dispatch never proceeds before recovery and the
        diagnostics gate complete. The claim is a compare-and-set, so two
        racing ticks can only ever commit one ``queued -> running``
        transition.
        """
        with self._lock:
            outcome = self._claim_locked()
        if isinstance(outcome, DispatchClaimed):
            self._notify_task_started(outcome.task_id, outcome.attempt_id)
            self._notify_queue_changed()
        return outcome

    def complete(
        self,
        task_id: TaskId,
        *,
        expected_state: LifecycleState,
        event: LifecycleEvent,
    ) -> TaskRecord:
        """Commit one terminal transition, then start the next queued task.

        The next dispatch runs only after the terminal transition and its
        event transaction have committed. A duplicate terminal callback for
        an already-terminal task returns the current record without a new
        dispatch, keeping completion and cancellation races idempotent.
        """
        with self._lock:
            record = self._commit_terminal_locked(task_id, expected_state, event)
        self._notify_queue_changed()
        _ = self.dispatch()
        return record

    def snapshot(self) -> QueueSnapshot:
        """Return an immutable FIFO snapshot of every persisted task."""
        with self._lock:
            return queue_snapshot(self._repository.list())

    def detail(self, task_id: TaskId) -> DetailSnapshot:
        """Return the immutable detail view of one task."""
        with self._lock:
            record = self._repository.get(task_id)
            if record is None:
                raise TaskNotFoundError(task_id=task_id)
            return detail_snapshot(
                record,
                self._repository.transitions(task_id),
                self._repository.history(task_id),
            )

    def _claim_locked(self) -> DispatchResult:
        """Select and claim the oldest queued task while the lock is held."""
        if not self._recovery_done:
            return DispatchBlocked(reason=DispatchBlockReason.RECOVERY_PENDING)
        if not self._diagnostics_ready:
            return DispatchBlocked(reason=DispatchBlockReason.DIAGNOSTICS_PENDING)
        records = self._repository.list()
        for record in records:
            if record.state in ACTIVE_STATES:
                return DispatchIdle(active_task_id=record.task_id)
        queued = tuple(
            record for record in records if record.state == LifecycleState.QUEUED
        )
        if not queued:
            return DispatchIdle(active_task_id=None)
        oldest = min(
            queued,
            key=lambda record: (record.position, record.created_at, record.task_id),
        )
        try:
            claimed = self._repository.transition(
                oldest.task_id,
                expected_state=LifecycleState.QUEUED,
                event=LifecycleEvent.START,
            )
        except StateMismatchError:
            return DispatchIdle(active_task_id=None)
        return DispatchClaimed(task_id=claimed.task_id, attempt_id=claimed.attempt_id)

    def _commit_terminal_locked(
        self,
        task_id: TaskId,
        expected_state: LifecycleState,
        event: LifecycleEvent,
    ) -> TaskRecord:
        """CAS one terminal transition, or return the current terminal record."""
        target_state = apply_transition(expected_state, event)
        if not is_terminal(target_state):
            raise NonTerminalCompletionError(task_id=task_id, target_state=target_state)
        try:
            return self._repository.transition(
                task_id, expected_state=expected_state, event=event
            )
        except StateMismatchError:
            current = self._repository.get(task_id)
            if current is not None and is_terminal(current.state):
                return current
            raise

    def _notify_task_started(self, task_id: TaskId, attempt_id: AttemptId) -> None:
        """Report one committed claim to the observer seam."""
        if self._observer is not None:
            self._observer.task_started(task_id, attempt_id)

    def _notify_queue_changed(self) -> None:
        """Report a queue mutation to the observer seam."""
        if self._observer is not None:
            self._observer.queue_changed()
