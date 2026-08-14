"""Windows integration tests for the active-task supervisor.

# noqa: SIZE_OK - one module must enumerate the full supervisor behavior
# matrix (envelope-after-assignment, preflight failure, exit mapping).

The supervisor composes the Job Object containment with the worker transport:
it releases the task envelope only after Job assignment, routes worker terminal
events to ``Scheduler.complete``, commits ``running -> failed`` on a preflight
failure (no work was done), and maps unexpected process exits to ``failed`` or
``interrupted`` based on shutdown context. Every worker is launched inside a
real Job Object, so each test also proves zero active processes remain.

These tests spawn real worker processes, so the whole module follows the
platform guard used by the Job Object and worker transport suites.
"""

from __future__ import annotations

import platform
import sqlite3
import sys
from typing import TYPE_CHECKING, Final, final

import pytest

from hubfetch.domain.ids import (
    AttemptId,
    TaskId,
    parse_attempt_id,
    parse_repository_id,
    parse_task_id,
)
from hubfetch.domain.lifecycle import AttemptRef, LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.scheduler import DispatchClaimed, Scheduler
from hubfetch.runtime.supervisor import Supervisor, SupervisorConfig
from tests.fixtures.process_tree import fixture_interpreter
from tests.helpers.clock import ControllableClock
from tests.runtime.worker_fixtures import worker_environment

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

READY_TIMEOUT_MS: Final = 10_000
SHORT_READY_TIMEOUT_MS: Final = 300

_SUCCEEDED_WORKER: Final = (
    "import sys\n"
    "from hubfetch.domain.ipc import SucceededEvent, WorkerReadyEvent\n"
    "from hubfetch.runtime.jsonl_framing import encode_event_frame\n"
    "from hubfetch.worker.handshake import WorkerEventWriter, read_envelope\n"
    "writer = WorkerEventWriter(sys.stdout.buffer)\n"
    "writer.emit(WorkerReadyEvent())\n"
    "frames = read_envelope(sys.stdin.buffer)\n"
    "start = frames[0].command\n"
    "writer.emit(SucceededEvent(task_id=start.task_id, attempt_id=start.attempt_id))\n"
    "sys.exit(0)\n"
)

_EXIT_THREE_WORKER: Final = (
    "import sys\n"
    "from hubfetch.domain.ipc import WorkerReadyEvent\n"
    "from hubfetch.runtime.jsonl_framing import encode_event_frame\n"
    "from hubfetch.worker.handshake import WorkerEventWriter, read_envelope\n"
    "writer = WorkerEventWriter(sys.stdout.buffer)\n"
    "writer.emit(WorkerReadyEvent())\n"
    "frames = read_envelope(sys.stdin.buffer)\n"
    "sys.exit(3)\n"
)


@final
class FakeOwner:
    """In-memory runtime owner recording acquisitions and releases."""

    __slots__: Final = ("acquire_count", "release_count")

    def __init__(self) -> None:
        self.acquire_count = 0
        self.release_count = 0

    def acquire(self) -> None:
        self.acquire_count += 1

    def release(self) -> None:
        self.release_count += 1


def _open_connection(database_path: Path) -> sqlite3.Connection:
    """Open a thread-safe connection with the persistence defaults."""
    connection = sqlite3.connect(
        database_path, isolation_level=None, check_same_thread=False
    )
    _ = connection.execute("PRAGMA foreign_keys = ON")
    _ = connection.execute("PRAGMA busy_timeout = 5000")
    _ = connection.execute("PRAGMA journal_mode = WAL")
    return connection


def _make_spec(destination: Path) -> GitCloneSpec:
    """Build one complete Git clone specification for supervisor tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=parse_repository_id("org/demo-model"), kind=ModelRepository()
        ),
        destination=destination,
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _claimed_task(
    tmp_path: Path,
) -> tuple[TaskRepository, Scheduler, sqlite3.Connection, TaskId, AttemptId]:
    """Persist one queued task, start the scheduler, and claim it as running."""
    clock = ControllableClock()
    connection = _open_connection(tmp_path / "supervisor.sqlite")
    migrate(connection)
    repository = TaskRepository(connection, clock=clock)
    task_id = parse_task_id("t-supervisor")
    attempt_id = parse_attempt_id("a-supervisor")
    _ = repository.create(task_id, _make_spec(tmp_path / "dest"), attempt_id)
    scheduler = Scheduler(repository, owner=FakeOwner())
    _ = scheduler.start()
    scheduler.mark_diagnostics_ready()
    outcome = scheduler.dispatch()
    assert isinstance(outcome, DispatchClaimed)
    return repository, scheduler, connection, outcome.task_id, outcome.attempt_id


def _write_worker(tmp_path: Path, source: str, name: str) -> tuple[str, ...]:
    """Write a rogue worker script and return its interpreter argv."""
    script = tmp_path / name
    _ = script.write_text(source, encoding="utf-8")
    return (sys.executable, "-u", str(script))


@final
class SupervisorBundle:
    """Task identity, worker argv, and timing for one supervisor."""

    __slots__: Final = ("argv", "attempt_id", "ready_timeout_ms", "task_id")

    def __init__(
        self,
        *,
        task_id: TaskId,
        attempt_id: AttemptId,
        argv: tuple[str, ...],
        ready_timeout_ms: int,
    ) -> None:
        self.task_id = task_id
        self.attempt_id = attempt_id
        self.argv = argv
        self.ready_timeout_ms = ready_timeout_ms


def _make_supervisor(
    bundle: SupervisorBundle,
    scheduler: Scheduler,
    repository: TaskRepository,
) -> Supervisor:
    """Compose a Supervisor for a claimed task with the given worker argv."""
    return Supervisor(
        config=SupervisorConfig(
            attempt=AttemptRef(task_id=bundle.task_id, attempt_id=bundle.attempt_id),
            argv=bundle.argv,
            environment=worker_environment(),
            ready_timeout_ms=bundle.ready_timeout_ms,
        ),
        scheduler=scheduler,
        repository=repository,
    )


def _assert_no_active_processes(qtbot: QtBot, supervisor: Supervisor) -> None:
    """Given a supervised Job, it converges to zero active processes."""
    qtbot.waitUntil(
        lambda: supervisor.job.active_process_ids() == (),
        timeout=READY_TIMEOUT_MS,
    )
    qtbot.waitUntil(lambda: not supervisor.worker.is_running, timeout=READY_TIMEOUT_MS)
    assert not supervisor.worker.is_running


def _is_state(
    repository: TaskRepository, task_id: TaskId, state: LifecycleState
) -> bool:
    """Return whether the persisted task currently sits in the given state."""
    record = repository.get(task_id)
    return record is not None and record.state == state


def test_supervisor_releases_envelope_only_after_assignment_and_succeeds(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a succeeding worker, the envelope follows assignment then succeeds."""
    repository, scheduler, connection, task_id, attempt_id = _claimed_task(tmp_path)
    argv = _write_worker(tmp_path, _SUCCEEDED_WORKER, "succeed_worker.py")
    supervisor = _make_supervisor(
        SupervisorBundle(
            task_id=task_id,
            attempt_id=attempt_id,
            argv=argv,
            ready_timeout_ms=READY_TIMEOUT_MS,
        ),
        scheduler,
        repository,
    )
    try:
        supervisor.start()
        qtbot.waitUntil(
            lambda: _is_state(repository, task_id, LifecycleState.SUCCEEDED),
            timeout=READY_TIMEOUT_MS,
        )
        qtbot.waitUntil(
            lambda: not supervisor.worker.is_running, timeout=READY_TIMEOUT_MS
        )
        record = repository.get(task_id)
        assert record is not None
        assert record.state == LifecycleState.SUCCEEDED
        assert supervisor.terminalized
        _assert_no_active_processes(qtbot, supervisor)
    finally:
        supervisor.close()
        connection.close()


def test_supervisor_preflight_failure_fails_running_no_work_done(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a worker that never becomes ready, running CASes to failed."""
    repository, scheduler, connection, task_id, attempt_id = _claimed_task(tmp_path)
    argv = (
        fixture_interpreter(),
        "-u",
        "-c",
        "import threading\nthreading.Event().wait()",
    )
    supervisor = _make_supervisor(
        SupervisorBundle(
            task_id=task_id,
            attempt_id=attempt_id,
            argv=argv,
            ready_timeout_ms=SHORT_READY_TIMEOUT_MS,
        ),
        scheduler,
        repository,
    )
    try:
        supervisor.start()
        qtbot.waitUntil(
            lambda: _is_state(repository, task_id, LifecycleState.FAILED),
            timeout=READY_TIMEOUT_MS,
        )
        record = repository.get(task_id)
        assert record is not None
        assert record.state == LifecycleState.FAILED
        assert supervisor.terminalized
    finally:
        supervisor.close()
        connection.close()

    # the never-ready worker was never assigned to the Job; close terminates it
    qtbot.waitUntil(lambda: not supervisor.worker.is_running, timeout=READY_TIMEOUT_MS)


def test_supervisor_unexpected_exit_maps_to_failed(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a worker that exits with no terminal event, the task fails."""
    repository, scheduler, connection, task_id, attempt_id = _claimed_task(tmp_path)
    argv = _write_worker(tmp_path, _EXIT_THREE_WORKER, "exit3_worker.py")
    supervisor = _make_supervisor(
        SupervisorBundle(
            task_id=task_id,
            attempt_id=attempt_id,
            argv=argv,
            ready_timeout_ms=READY_TIMEOUT_MS,
        ),
        scheduler,
        repository,
    )
    try:
        supervisor.start()
        qtbot.waitUntil(
            lambda: _is_state(repository, task_id, LifecycleState.FAILED),
            timeout=READY_TIMEOUT_MS,
        )
        record = repository.get(task_id)
        assert record is not None
        assert record.state == LifecycleState.FAILED
        assert supervisor.terminalized
        _assert_no_active_processes(qtbot, supervisor)
    finally:
        supervisor.close()
        connection.close()


def test_supervisor_unexpected_exit_maps_to_interrupted_in_shutdown_context(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a shutdown context, an unexpected exit commits interrupted."""
    repository, scheduler, connection, task_id, attempt_id = _claimed_task(tmp_path)
    argv = _write_worker(tmp_path, _EXIT_THREE_WORKER, "exit3_shutdown_worker.py")
    supervisor = _make_supervisor(
        SupervisorBundle(
            task_id=task_id,
            attempt_id=attempt_id,
            argv=argv,
            ready_timeout_ms=READY_TIMEOUT_MS,
        ),
        scheduler,
        repository,
    )
    supervisor.begin_shutdown()
    try:
        supervisor.start()
        qtbot.waitUntil(
            lambda: _is_state(repository, task_id, LifecycleState.INTERRUPTED),
            timeout=READY_TIMEOUT_MS,
        )
        record = repository.get(task_id)
        assert record is not None
        assert record.state == LifecycleState.INTERRUPTED
        assert supervisor.terminalized
    finally:
        supervisor.close()
        connection.close()

    # the never-ready worker was never assigned to the Job; close terminates it
    assert not supervisor.worker.is_running
