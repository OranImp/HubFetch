"""Supervise one active task through its contained worker and Job containment.

The supervisor composes Todo 13's :class:`JobObject` with Todo 14's
:class:`WorkerProcess` into the single owner of one active task attempt. It
launches the worker, assigns it to the Job only after ``worker_ready``, sends
the typed task envelope only after assignment, and routes every worker event to
the application service (``Scheduler.complete`` for terminal events, and the
forwarded event kinds for progress persistence). A preflight failure or an
unexpected process exit is committed as a CAS ``running -> failed`` transition,
so a task never claims ``running`` when no work was done.

Cancellation and runtime close are driven by :mod:`cancellation` and
:mod:`shutdown`; this module owns the worker lifecycle and the ordinary
terminal routing. The supervisor is Windows-only (Job Objects).
"""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import QObject, Signal

from hubfetch.domain.ipc import StartTaskCommand
from hubfetch.domain.lifecycle import (
    LifecycleEvent,
    LifecycleState,
    is_terminal,
)
from hubfetch.persistence.records import StateMismatchError
from hubfetch.platform.windows.job_object import JobObject, JobObjectError
from hubfetch.runtime.worker_process import WorkerProcess
from hubfetch.runtime.worker_process_types import (
    DEFAULT_READY_TIMEOUT_MS,
    WorkerProcessStateError,
)

if TYPE_CHECKING:
    from PySide6.QtCore import QProcessEnvironment

    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.lifecycle import AttemptRef
    from hubfetch.persistence.task_repository import TaskRepository
    from hubfetch.runtime.scheduler import Scheduler

_TERMINAL_EVENT_FROM: Final = {
    ("succeeded", LifecycleState.RUNNING): LifecycleEvent.SUCCEEDED,
    ("failed", LifecycleState.RUNNING): LifecycleEvent.FAILED,
}


@dataclass(frozen=True, slots=True)
class SupervisorConfig:
    """Typed launch settings for one supervised task attempt."""

    attempt: AttemptRef
    argv: tuple[str, ...]
    environment: QProcessEnvironment
    ready_timeout_ms: int = DEFAULT_READY_TIMEOUT_MS


@final
class Supervisor(QObject):
    """Own one active task's worker, Job, and terminal routing."""

    task_running = Signal(str)
    """Emitted with the task id once assignment and the envelope succeeded."""

    task_terminal = Signal(str, str)
    """Emitted with the task id and committed terminal kind once terminalized."""

    task_failed = Signal(str, str)
    """Emitted with the task id and code when a preflight failure is committed."""

    exited = Signal(str, int)
    """Emitted with the task id and exit code whenever the worker process exits."""

    progress_received = Signal(str)
    """Emitted with each forwarded worker event kind for progress persistence."""

    stderr_sanitized = Signal(str)
    """Forwarded redacted worker stderr text for diagnostics surfaces."""

    __slots__: Final = (
        "_attempt_id",
        "_closed",
        "_job",
        "_repository",
        "_scheduler",
        "_shutting_down",
        "_task_id",
        "_terminalized",
        "_worker",
    )
    _task_id: TaskId
    _attempt_id: AttemptId
    _scheduler: Scheduler
    _repository: TaskRepository
    _shutting_down: bool
    _terminalized: bool
    _closed: bool
    _job: JobObject
    _worker: WorkerProcess

    def __init__(
        self,
        *,
        config: SupervisorConfig,
        scheduler: Scheduler,
        repository: TaskRepository,
    ) -> None:
        """Compose one Job with one WorkerProcess for the given attempt."""
        super().__init__()
        self._task_id = config.attempt.task_id
        self._attempt_id = config.attempt.attempt_id
        self._scheduler = scheduler
        self._repository = repository
        self._shutting_down = False
        self._terminalized = False
        self._closed = False
        self._job = JobObject()
        self._worker = WorkerProcess(
            argv=config.argv,
            environment=config.environment,
            job=self._job,
            ready_timeout_ms=config.ready_timeout_ms,
        )
        _ = self._worker.ready.connect(self._on_ready)
        _ = self._worker.assigned.connect(self._on_assigned)
        _ = self._worker.event_received.connect(self._on_event_received)
        _ = self._worker.terminal_event.connect(self._on_terminal)
        _ = self._worker.preflight_failed.connect(self._on_preflight_failed)
        _ = self._worker.process_exited.connect(self._on_process_exited)
        _ = self._worker.stderr_sanitized.connect(self.stderr_sanitized)

    @property
    def job(self) -> JobObject:
        """Return the Job the worker tree is contained in."""
        return self._job

    @property
    def worker(self) -> WorkerProcess:
        """Return the supervised worker transport."""
        return self._worker

    @property
    def task_id(self) -> TaskId:
        """Return the supervised task identifier."""
        return self._task_id

    @property
    def terminalized(self) -> bool:
        """Return whether a terminal transition has already been committed."""
        return self._terminalized

    def start(self) -> None:
        """Launch the contained worker and begin supervision."""
        self._worker.start()

    def begin_shutdown(self) -> None:
        """Enter shutdown context: commits bypass dispatch (no next task)."""
        self._shutting_down = True

    def _on_ready(self, _pid: int) -> None:
        """Assign the live worker to the Job as soon as it is ready."""
        self._worker.assign()

    def _on_assigned(self, _pid: int) -> None:
        """Release the task envelope once the worker is inside the Job."""
        record = self._repository.get(self._task_id)
        if record is None or is_terminal(record.state):
            return
        if record.state == LifecycleState.CANCELLING:
            return  # cancellation owns the CANCELLING path; never release work
        try:
            self._worker.send_envelope(
                StartTaskCommand(
                    task_id=self._task_id,
                    attempt_id=self._attempt_id,
                    spec=record.spec,
                )
            )
        except WorkerProcessStateError:
            self._commit_terminal(LifecycleEvent.FAILED, emit_kind="failed")
            return
        self.task_running.emit(self._task_id)

    def _on_event_received(self, kind: str) -> None:
        """Forward one worker event kind for application-side progress routing."""
        self.progress_received.emit(kind)

    def _on_terminal(self, kind: str) -> None:
        """Commit the typed terminal transition for a worker terminal event.

        Terminal events arriving while the attempt is ``cancelling`` belong to
        the :class:`CancellationController`; the supervisor defers to it so
        terminalization happens exactly once.
        """
        if self._terminalized or self._closed:
            return
        record = self._repository.get(self._task_id)
        if record is None or is_terminal(record.state):
            self._terminalized = True
            return
        if record.state == LifecycleState.CANCELLING:
            return  # the cancellation controller owns this path
        event = _TERMINAL_EVENT_FROM.get((kind, record.state))
        if event is None:
            return  # untyped or unexpected terminal kind; exit routing owns it
        self._commit_terminal(event, emit_kind=kind)

    def _on_preflight_failed(self, code: str, _detail: str) -> None:
        """Commit ``running -> failed`` because no work was done."""
        if self._terminalized:
            return
        self._commit_terminal(LifecycleEvent.FAILED, emit_kind="failed")
        self.task_failed.emit(self._task_id, code)

    def _on_process_exited(self, exit_code: int) -> None:
        """Commit a terminal transition when the worker exits unexpectedly."""
        self.exited.emit(self._task_id, exit_code)
        if self._terminalized or self._closed:
            return
        record = self._repository.get(self._task_id)
        if record is None or is_terminal(record.state):
            self._terminalized = True
            return
        if record.state == LifecycleState.CANCELLING:
            return  # the cancellation controller owns the CANCELLING path
        event = (
            LifecycleEvent.INTERRUPTED if self._shutting_down else LifecycleEvent.FAILED
        )
        self._commit_terminal(
            event, emit_kind="interrupted" if self._shutting_down else "failed"
        )

    def _commit_terminal(self, event: LifecycleEvent, *, emit_kind: str) -> None:
        """CAS one terminal transition exactly once; never dispatch on close."""
        if self._terminalized or self._closed:
            return
        self._terminalized = True
        record = self._repository.get(self._task_id)
        if record is None:
            return
        try:
            if self._shutting_down:
                _ = self._repository.transition(
                    self._task_id, expected_state=record.state, event=event
                )
            else:
                _ = self._scheduler.complete(
                    self._task_id, expected_state=record.state, event=event
                )
        except StateMismatchError:
            pass  # a racing terminalization already committed
        self.task_terminal.emit(self._task_id, emit_kind)

    def close(self) -> None:
        """Stop event routing, terminate the worker tree, and close the Job."""
        if self._closed:
            return
        self._closed = True
        if self._worker.is_running:
            self._worker.terminate()
        with suppress(JobObjectError):
            self._job.close()


__all__: Final = ("Supervisor", "SupervisorConfig")
