"""Active cancellation of one supervised task through its Job containment.

CAS-commits ``cancelling``, sends one :class:`CancelTaskCommand`, waits the
grace period for a cooperative ack, escalates to ``TerminateJobObject`` when
unresponsive, and persists ``cancelled`` only after the Job reports zero
active processes and the final ``cancel_confirmed`` event is committed. Only
the empty-Job observation is proof; races terminalize exactly once.
"""

from __future__ import annotations

import time
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import QObject, QTimer, Signal

from hubfetch.domain.ipc import CancelTaskCommand
from hubfetch.domain.lifecycle import (
    AttemptRef,
    LifecycleEvent,
    LifecycleState,
    is_terminal,
)
from hubfetch.persistence.records import StateMismatchError
from hubfetch.platform.windows.job_object import JobObject, JobObjectError
from hubfetch.runtime.worker_process_types import WorkerProcessStateError

if TYPE_CHECKING:
    from collections.abc import Callable

    from hubfetch.persistence.task_repository import TaskRepository
    from hubfetch.runtime.scheduler import Scheduler
    from hubfetch.runtime.worker_process import WorkerProcess

_POLL_INTERVAL_MS: Final = 25


@dataclass(frozen=True, slots=True)
class ContainedWorker:
    """The Job containment and transport of one supervised worker tree."""

    job: JobObject
    worker: WorkerProcess


@dataclass(frozen=True, slots=True)
class CancellationConfig:
    """Typed attempt identity and bounded timing for one cancellation."""

    attempt: AttemptRef
    grace_period_ms: int
    confirm_timeout_ms: int
    shutting_down: Callable[[], bool] | None = None


@final
class CancellationController(QObject):
    """Drive one attempt from ``running`` through ``cancelling`` to terminal."""

    cancelled = Signal(str)
    failed = Signal(str, str)

    __slots__: Final = (
        "_attempt_id",
        "_cancel_wins",
        "_closed",
        "_confirm_timeout_ms",
        "_cooperative_ack",
        "_deadline",
        "_escalated",
        "_forced",
        "_grace_timer",
        "_job",
        "_outcome",
        "_poll_timer",
        "_repository",
        "_scheduler",
        "_shutting_down",
        "_task_id",
        "_terminalized",
        "_worker",
    )

    def __init__(
        self,
        *,
        config: CancellationConfig,
        contained: ContainedWorker,
        scheduler: Scheduler,
        repository: TaskRepository,
    ) -> None:
        """Bind the cancel flow to the attempt's Job, worker, and store."""
        super().__init__()
        self._task_id = config.attempt.task_id
        self._attempt_id = config.attempt.attempt_id
        self._job = contained.job
        self._worker = contained.worker
        self._scheduler = scheduler
        self._repository = repository
        self._shutting_down = (
            config.shutting_down if config.shutting_down is not None else _never
        )
        self._cooperative_ack = False
        self._escalated = False
        self._forced = False
        self._cancel_wins = False
        self._outcome = None
        self._deadline = 0.0
        self._terminalized = False
        self._closed = False
        self._confirm_timeout_ms = config.confirm_timeout_ms
        self._grace_timer = QTimer(self)
        self._grace_timer.setSingleShot(True)
        self._grace_timer.setInterval(config.grace_period_ms)
        _ = self._grace_timer.timeout.connect(self._on_grace_timeout)
        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(_POLL_INTERVAL_MS)
        _ = self._poll_timer.timeout.connect(self._poll)
        _ = self._worker.terminal_event.connect(self._on_terminal)
        _ = self._worker.process_exited.connect(self._on_process_exited)

    @property
    def terminalized(self) -> bool:
        """Return whether a terminal transition has already been committed."""
        return self._terminalized

    def close(self) -> None:
        """Stop listening and timers so no store access follows the teardown."""
        if self._closed:
            return
        self._closed = True
        self._grace_timer.stop()
        self._poll_timer.stop()
        _ = self._worker.terminal_event.disconnect(self._on_terminal)
        _ = self._worker.process_exited.disconnect(self._on_process_exited)

    def begin(self) -> bool:
        """CAS ``cancelling`` and send exactly one cancel command."""
        if self._terminalized:
            return False
        try:
            _ = self._repository.transition(
                self._task_id,
                expected_state=LifecycleState.RUNNING,
                event=LifecycleEvent.CANCEL,
            )
        except StateMismatchError:
            return False
        try:
            self._worker.send_command(
                CancelTaskCommand(task_id=self._task_id, attempt_id=self._attempt_id)
            )
        except WorkerProcessStateError:
            # a send failure is a surface error; escalate immediately
            self._escalate()
            self._start_confirm()
            return True
        self._grace_timer.start()
        return True

    def _on_terminal(self, kind: str) -> None:
        if self._terminalized or self._closed:
            return
        if kind == "cancelled":
            self._cooperative_ack = True
            self._grace_timer.stop()
            self._start_confirm()
        elif kind == "failed":
            self._outcome = LifecycleEvent.FAILED
            self._grace_timer.stop()
            self._escalate()
            self._start_confirm()
        elif kind == "succeeded":
            self._cancel_wins = True  # cancellation won the CAS race
            self._grace_timer.stop()
            self._start_confirm()

    def _on_process_exited(self, _exit_code: int) -> None:
        if self._terminalized or self._closed:
            return
        if self._cooperative_ack or self._forced:
            self._start_confirm()
            return
        shutting_down = self._shutting_down()
        self._outcome = (
            LifecycleEvent.INTERRUPTED if shutting_down else LifecycleEvent.FAILED
        )
        self._grace_timer.stop()
        self._escalate()
        self._start_confirm()

    def _on_grace_timeout(self) -> None:
        if self._terminalized:
            return
        self._forced = True
        self._escalate()
        self._start_confirm()

    def _escalate(self) -> None:
        if self._escalated:
            return
        self._escalated = True
        with suppress(JobObjectError):
            self._job.terminate()

    def _start_confirm(self) -> None:
        self._deadline = time.monotonic() + self._confirm_timeout_ms / 1000.0
        self._poll_timer.start()
        self._poll()

    def _poll(self) -> None:
        if self._terminalized or self._closed:
            self._poll_timer.stop()
            return
        if self._job_empty():
            self._poll_timer.stop()
            self._commit_observed_outcome()
        elif time.monotonic() >= self._deadline:
            self._poll_timer.stop()
            self._commit_timeout_outcome()

    def _job_empty(self) -> bool:
        try:
            return not self._job.active_process_ids()
        except JobObjectError:
            return True  # a closed Job holds no processes

    def _commit_observed_outcome(self) -> None:
        if self._cooperative_ack or self._forced or self._cancel_wins:
            self._terminalize(LifecycleEvent.CANCEL_CONFIRMED, emit="cancelled")
            return
        self._terminalize(self._outcome or LifecycleEvent.FAILED, emit="failed")

    def _commit_timeout_outcome(self) -> None:
        shutting_down = self._shutting_down()
        self._terminalize(
            LifecycleEvent.INTERRUPTED if shutting_down else LifecycleEvent.FAILED,
            emit="interrupted" if shutting_down else "failed",
        )

    def _terminalize(self, event: LifecycleEvent, *, emit: str) -> None:
        if self._terminalized or self._closed:
            return
        self._terminalized = True
        self._grace_timer.stop()
        self._poll_timer.stop()
        record = self._repository.get(self._task_id)
        if record is None or is_terminal(record.state):
            return
        try:
            if self._shutting_down():
                _ = self._repository.transition(
                    self._task_id,
                    expected_state=LifecycleState.CANCELLING,
                    event=event,
                )
            else:
                _ = self._scheduler.complete(
                    self._task_id,
                    expected_state=LifecycleState.CANCELLING,
                    event=event,
                )
        except StateMismatchError:
            pass  # a racing path already terminalized
        if emit == "cancelled":
            self.cancelled.emit(self._task_id)
        else:
            self.failed.emit(self._task_id, emit)


def _never() -> bool:
    return False


__all__: Final = ("CancellationConfig", "CancellationController", "ContainedWorker")
