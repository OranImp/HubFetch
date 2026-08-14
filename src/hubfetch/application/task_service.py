"""Application commands and snapshots over the transactional task store.

The service owns create, cancel, and retry commands and exposes the
immutable queue/detail snapshots the UI consumes. It stays free of Qt
imports; the optional ``on_queue_changed`` callback lets the composition
root wake the scheduler after each persisted mutation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final, override

from hubfetch.domain.ids import parse_task_id
from hubfetch.domain.lifecycle import (
    AttemptRef,
    LifecycleEvent,
    LifecycleState,
    retry_attempt,
)
from hubfetch.domain.task_spec import GitCloneSpec
from hubfetch.persistence.records import TaskNotFoundError

from .snapshots import detail_snapshot, queue_snapshot

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.persistence.records import TaskRecord
    from hubfetch.persistence.task_repository import TaskRepository

    from .snapshots import DetailSnapshot, QueueSnapshot


@dataclass(frozen=True, slots=True)
class RetryDestinationNotReadyError(ValueError):
    """A Git retry must reference an empty or new destination."""

    destination: Path
    reason: str

    @override
    def __str__(self) -> str:
        return f"retry destination {self.destination} is not ready: {self.reason}"


@dataclass(frozen=True, slots=True)
class TaskAlreadyExistsError(ValueError):
    """A task identifier may only be created once."""

    task_id: TaskId

    @override
    def __str__(self) -> str:
        return f"task {self.task_id} already exists"


@dataclass(frozen=True, slots=True)
class RetryResult:
    """The newly queued attempt created for a retried terminal task."""

    task_id: TaskId
    attempt_id: AttemptId
    linked_from: AttemptId
    position: int


def _retry_task_id(original_task_id: TaskId, new_attempt_id: AttemptId) -> TaskId:
    """Derive the persisted row identifier of a retried attempt.

    The schema stores one row per task and exposes no attempt-append
    primitive, so a retried attempt is a fresh queued row whose identifier
    deterministically records the original task and the new attempt for
    history and recovery.
    """
    return parse_task_id(f"{original_task_id}#{new_attempt_id}")


def _validate_git_retry_destination(spec: TaskSpec) -> None:
    """Reject a Git retry whose destination already holds a working tree.

    Git clone has no in-place resume contract, so a retry may only target a
    new or empty destination; the user must choose a fresh path or clean it
    up before the attempt can be created.
    """
    if not isinstance(spec, GitCloneSpec):
        return
    destination = spec.destination
    if not destination.exists():
        return
    if not destination.is_dir():
        raise RetryDestinationNotReadyError(
            destination=destination, reason="destination is not a directory"
        )
    if any(destination.iterdir()):
        raise RetryDestinationNotReadyError(
            destination=destination, reason="destination is not empty"
        )


@final
class TaskService:
    """Typed create/cancel/retry commands plus immutable snapshots."""

    __slots__: Final = ("_on_queue_changed", "_repository")
    _repository: TaskRepository
    _on_queue_changed: Callable[[], None] | None

    def __init__(
        self,
        repository: TaskRepository,
        *,
        on_queue_changed: Callable[[], None] | None = None,
    ) -> None:
        """Bind the service to the repository and optional scheduler wake."""
        self._repository = repository
        self._on_queue_changed = on_queue_changed

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Atomically persist one confirmed task as queued."""
        if self._repository.get(task_id) is not None:
            raise TaskAlreadyExistsError(task_id=task_id)
        record = self._repository.create(task_id, spec, attempt_id)
        self._notify()
        return record

    def cancel(self, task_id: TaskId) -> TaskRecord:
        """Persist a queued task as cancelled without starting any worker.

        A task that is no longer queued raises the repository's typed
        compare-and-set error; active cancellation belongs to the supervisor.
        """
        record = self._repository.transition(
            task_id,
            expected_state=LifecycleState.QUEUED,
            event=LifecycleEvent.CANCEL,
        )
        self._notify()
        return record

    def retry(self, task_id: TaskId, *, new_attempt_id: AttemptId) -> RetryResult:
        """Queue a new attempt linked to a failed, cancelled, or interrupted task.

        Succeeded and in-flight tasks are rejected by the domain gate; a Git
        clone must already reference a new or empty destination.
        """
        record = self._repository.get(task_id)
        if record is None:
            raise TaskNotFoundError(task_id=task_id)
        new_attempt = retry_attempt(
            AttemptRef(task_id=task_id, attempt_id=record.attempt_id),
            record.state,
            new_attempt_id,
        )
        _validate_git_retry_destination(record.spec)
        created = self._repository.create(
            _retry_task_id(task_id, new_attempt.attempt_id),
            record.spec,
            new_attempt.attempt_id,
        )
        self._notify()
        return RetryResult(
            task_id=created.task_id,
            attempt_id=created.attempt_id,
            linked_from=new_attempt.linked_from,
            position=created.position,
        )

    def snapshot(self) -> QueueSnapshot:
        """Return an immutable FIFO snapshot of every persisted task."""
        return queue_snapshot(self._repository.list())

    def detail(self, task_id: TaskId) -> DetailSnapshot:
        """Return the immutable detail view of one task."""
        record = self._repository.get(task_id)
        if record is None:
            raise TaskNotFoundError(task_id=task_id)
        return detail_snapshot(
            record,
            self._repository.transitions(task_id),
            self._repository.history(task_id),
        )

    def _notify(self) -> None:
        """Wake the scheduler after a persisted mutation."""
        if self._on_queue_changed is not None:
            self._on_queue_changed()
