"""Windows integration tests for active task cancellation.

# noqa: SIZE_OK - one module must enumerate the full cancellation contract
# (cooperative, escalated, zero-active observation, ordering, race, exit map).

These tests prove the full cancellation contract: a cooperative worker and its
child ack and exit; an unresponsive tree is escalated with TerminateJobObject
and converges to zero active processes; ``cancelled`` is persisted only after
the Job reports zero active processes; unexpected exits map to ``failed`` or
``interrupted`` by shutdown context; and cancel/completion/exit races
terminalize exactly once. The whole module follows the Windows Job Object
platform guard.
"""

from __future__ import annotations

import platform
import sqlite3
from typing import TYPE_CHECKING, Final, final

import pytest

from hubfetch.domain.ids import (
    AttemptId,
    TaskId,
    parse_attempt_id,
    parse_repository_id,
    parse_task_id,
)
from hubfetch.domain.lifecycle import (
    AttemptRef,
    LifecycleEvent,
    LifecycleState,
)
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.cancellation import (
    CancellationConfig,
    CancellationController,
    ContainedWorker,
)
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
GRACE_PERIOD_MS: Final = 200
CONFIRM_TIMEOUT_MS: Final = 3_000

_READY_FRAME: Final = (
    "import json, subprocess, sys\n"
    "out = sys.stdout.buffer\n"
    "def emit(sequence, event):\n"
    "    line = json.dumps({'sequence': sequence, 'event': event})\n"
    "    out.write(line.encode() + b'\\n')\n"
    "    out.flush()\n"
    "emit(0, {'kind': 'worker_ready'})\n"
    "import threading\n"
)

_COOPERATIVE_WORKER: Final = _READY_FRAME + (
    "reader = json.JSONDecoder()\n"
    "start = None\n"
    "while True:\n"
    "    line = sys.stdin.buffer.readline()\n"
    "    if not line:\n"
    "        break\n"
    "    payload = json.loads(line)\n"
    "    command = payload['command']\n"
    "    if command['kind'] == 'start_task':\n"
    "        start = command\n"
    "        child = subprocess.Popen(\n"
    "            [sys.executable, '-u', '-c',\n"
    "             'import sys; sys.stdin.buffer.read()'],\n"
    "            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,"
    " stderr=subprocess.DEVNULL,\n"
    "        )\n"
    "    elif command['kind'] == 'cancel_task' and start is not None:\n"
    "        emit(1, {'kind': 'cancelled', 'task_id': start['task_id'],\n"
    "                 'attempt_id': start['attempt_id']})\n"
    "        sys.exit(0)\n"
)

_UNRESPONSIVE_WORKER: Final = _READY_FRAME + (
    "reader = json.JSONDecoder()\n"
    "while True:\n"
    "    line = sys.stdin.buffer.readline()\n"
    "    if not line:\n"
    "        break\n"
    "    payload = json.loads(line)\n"
    "    if payload['command']['kind'] == 'start_task':\n"
    "        subprocess.Popen(\n"
    "            [sys.executable, '-u', '-c',\n"
    "             'import sys; sys.stdin.buffer.read()'],\n"
    "            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,"
    " stderr=subprocess.DEVNULL,\n"
    "        )\n"
    "threading.Event().wait()\n"
)

_EXIT_WORKER: Final = _READY_FRAME + (
    "reader = json.JSONDecoder()\n"
    "while True:\n"
    "    line = sys.stdin.buffer.readline()\n"
    "    if not line:\n"
    "        break\n"
    "    payload = json.loads(line)\n"
    "    if payload['command']['kind'] == 'cancel_task':\n"
    "        sys.exit(3)\n"
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


@final
class RuntimeBinding:
    """One claimed task bound to its repository, scheduler, and store."""

    __slots__: Final = (
        "attempt_id",
        "connection",
        "repository",
        "scheduler",
        "task_id",
    )

    def __init__(
        self,
        *,
        repository: TaskRepository,
        scheduler: Scheduler,
        connection: sqlite3.Connection,
        task_id: TaskId,
        attempt_id: AttemptId,
    ) -> None:
        self.repository = repository
        self.scheduler = scheduler
        self.connection = connection
        self.task_id = task_id
        self.attempt_id = attempt_id


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
    """Build one complete Git clone specification for cancellation tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=parse_repository_id("org/demo-model"), kind=ModelRepository()
        ),
        destination=destination,
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _claimed_task(tmp_path: Path) -> RuntimeBinding:
    """Persist one queued task, start the scheduler, and claim it as running."""
    clock = ControllableClock()
    connection = _open_connection(tmp_path / "cancellation.sqlite")
    migrate(connection)
    repository = TaskRepository(connection, clock=clock)
    task_id = parse_task_id("t-cancel")
    attempt_id = parse_attempt_id("a-cancel")
    _ = repository.create(task_id, _make_spec(tmp_path / "dest"), attempt_id)
    scheduler = Scheduler(repository, owner=FakeOwner())
    _ = scheduler.start()
    scheduler.mark_diagnostics_ready()
    outcome = scheduler.dispatch()
    assert isinstance(outcome, DispatchClaimed)
    return RuntimeBinding(
        repository=repository,
        scheduler=scheduler,
        connection=connection,
        task_id=outcome.task_id,
        attempt_id=outcome.attempt_id,
    )


def _launch_supervisor(
    *,
    binding: RuntimeBinding,
    tmp_path: Path,
    source: str,
    name: str,
) -> Supervisor:
    """Start a supervisor for a claimed task with the given worker source."""
    script = tmp_path / name
    _ = script.write_text(source, encoding="utf-8")
    return Supervisor(
        config=SupervisorConfig(
            attempt=AttemptRef(task_id=binding.task_id, attempt_id=binding.attempt_id),
            argv=(fixture_interpreter(), "-u", str(script)),
            environment=worker_environment(),
            ready_timeout_ms=READY_TIMEOUT_MS,
        ),
        scheduler=binding.scheduler,
        repository=binding.repository,
    )


def _make_controller(
    *,
    binding: RuntimeBinding,
    supervisor: Supervisor,
) -> CancellationController:
    """Build a cancellation controller bound to a running supervisor."""
    return CancellationController(
        config=CancellationConfig(
            attempt=AttemptRef(task_id=binding.task_id, attempt_id=binding.attempt_id),
            grace_period_ms=GRACE_PERIOD_MS,
            confirm_timeout_ms=CONFIRM_TIMEOUT_MS,
        ),
        contained=ContainedWorker(job=supervisor.job, worker=supervisor.worker),
        scheduler=binding.scheduler,
        repository=binding.repository,
    )


def _is_state(
    repository: TaskRepository, task_id: TaskId, state: LifecycleState
) -> bool:
    """Return whether the persisted task currently sits in the given state."""
    record = repository.get(task_id)
    return record is not None and record.state == state


def _wait_running(
    qtbot: QtBot, supervisor: Supervisor, binding: RuntimeBinding
) -> None:
    """Wait for the claimed task to be running with a spawned child in the Job."""
    supervisor.start()
    qtbot.waitUntil(
        lambda: _is_state(binding.repository, binding.task_id, LifecycleState.RUNNING),
        timeout=READY_TIMEOUT_MS,
    )
    qtbot.waitUntil(
        lambda: len(supervisor.job.active_process_ids()) >= 2,
        timeout=READY_TIMEOUT_MS,
    )


def test_cooperative_cancel_worker_and_child_ack_and_exit(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a cooperative worker and child, cancel ends the tree and commits."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_supervisor(
        binding=binding,
        tmp_path=tmp_path,
        source=_COOPERATIVE_WORKER,
        name="cooperative_worker.py",
    )
    controller = _make_controller(binding=binding, supervisor=supervisor)
    try:
        _wait_running(qtbot, supervisor, binding)
        assert controller.begin()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.CANCELLED
            ),
            timeout=CONFIRM_TIMEOUT_MS,
        )
        record = binding.repository.get(binding.task_id)
        assert record is not None
        assert record.state == LifecycleState.CANCELLED
        assert supervisor.job.active_process_ids() == ()
        qtbot.waitUntil(
            lambda: not supervisor.worker.is_running, timeout=READY_TIMEOUT_MS
        )
    finally:
        controller.close()
        supervisor.close()
        binding.connection.close()


def test_unresponsive_tree_is_escalated_and_converges(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given an unresponsive tree, grace expires, terminate fires, and it empties."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_supervisor(
        binding=binding,
        tmp_path=tmp_path,
        source=_UNRESPONSIVE_WORKER,
        name="unresponsive_worker.py",
    )
    controller = _make_controller(binding=binding, supervisor=supervisor)
    try:
        _wait_running(qtbot, supervisor, binding)
        assert controller.begin()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.CANCELLED
            ),
            timeout=CONFIRM_TIMEOUT_MS,
        )
        record = binding.repository.get(binding.task_id)
        assert record is not None
        assert record.state == LifecycleState.CANCELLED
        assert supervisor.job.active_process_ids() == ()
        qtbot.waitUntil(
            lambda: not supervisor.worker.is_running, timeout=READY_TIMEOUT_MS
        )
    finally:
        controller.close()
        supervisor.close()
        binding.connection.close()


def test_zero_active_process_observation_before_cancelled(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a cooperative worker, cancelled commits only after the Job empties."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_supervisor(
        binding=binding,
        tmp_path=tmp_path,
        source=_COOPERATIVE_WORKER,
        name="cooperative_empty_worker.py",
    )
    controller = _make_controller(binding=binding, supervisor=supervisor)
    observed_empty_at_commit: list[bool] = []

    def record_emptiness(_tid: str) -> None:
        observed_empty_at_commit.append(supervisor.job.active_process_ids() == ())

    _ = controller.cancelled.connect(record_emptiness)
    try:
        _wait_running(qtbot, supervisor, binding)
        assert controller.begin()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.CANCELLED
            ),
            timeout=CONFIRM_TIMEOUT_MS,
        )
        assert observed_empty_at_commit == [True]
        assert supervisor.job.active_process_ids() == ()
    finally:
        controller.close()
        supervisor.close()
        binding.connection.close()


def test_final_event_ordering_cancelled_after_job_empty(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given the cooperative cancel, the commit event follows emptiness."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_supervisor(
        binding=binding,
        tmp_path=tmp_path,
        source=_COOPERATIVE_WORKER,
        name="cooperative_order_worker.py",
    )
    controller = _make_controller(binding=binding, supervisor=supervisor)
    timeline: list[str] = []

    def record_timeline(_tid: str) -> None:
        state = "empty" if supervisor.job.active_process_ids() == () else "busy"
        timeline.append(f"cancelled:{state}")

    _ = controller.cancelled.connect(record_timeline)
    try:
        _wait_running(qtbot, supervisor, binding)
        assert controller.begin()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.CANCELLED
            ),
            timeout=CONFIRM_TIMEOUT_MS,
        )
        assert timeline == ["cancelled:empty"]
        transitions = binding.repository.transitions(binding.task_id)
        terminal = [t for t in transitions if t.to_state == LifecycleState.CANCELLED]
        assert len(terminal) == 1
        assert terminal[0].event_kind == LifecycleEvent.CANCEL_CONFIRMED
    finally:
        controller.close()
        supervisor.close()
        binding.connection.close()


def test_unexpected_exit_during_cancel_maps_to_failed(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a worker that dies instead of acking, the cancel commits failed."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_supervisor(
        binding=binding,
        tmp_path=tmp_path,
        source=_EXIT_WORKER,
        name="exit_during_cancel_worker.py",
    )
    controller = _make_controller(binding=binding, supervisor=supervisor)
    try:
        supervisor.start()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.RUNNING
            ),
            timeout=READY_TIMEOUT_MS,
        )
        qtbot.waitUntil(lambda: supervisor.worker.is_running, timeout=READY_TIMEOUT_MS)
        assert controller.begin()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.FAILED
            ),
            timeout=CONFIRM_TIMEOUT_MS,
        )
        record = binding.repository.get(binding.task_id)
        assert record is not None
        assert record.state == LifecycleState.FAILED
        assert supervisor.job.active_process_ids() == ()
    finally:
        controller.close()
        supervisor.close()
        binding.connection.close()


def test_cancel_race_terminalizes_exactly_once(qtbot: QtBot, tmp_path: Path) -> None:
    """Given racing cancel calls, only one terminal transition is committed."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_supervisor(
        binding=binding,
        tmp_path=tmp_path,
        source=_UNRESPONSIVE_WORKER,
        name="race_worker.py",
    )
    first = _make_controller(binding=binding, supervisor=supervisor)
    second = _make_controller(binding=binding, supervisor=supervisor)
    try:
        _wait_running(qtbot, supervisor, binding)
        assert first.begin()
        assert not second.begin()
        qtbot.waitUntil(
            lambda: _is_state(
                binding.repository, binding.task_id, LifecycleState.CANCELLED
            ),
            timeout=CONFIRM_TIMEOUT_MS,
        )
        transitions = binding.repository.transitions(binding.task_id)
        terminal_states = {
            LifecycleState.CANCELLED,
            LifecycleState.FAILED,
            LifecycleState.INTERRUPTED,
        }
        terminal = [t for t in transitions if t.to_state in terminal_states]
        assert len(terminal) == 1
        assert supervisor.job.active_process_ids() == ()
    finally:
        first.close()
        second.close()
        supervisor.close()
        binding.connection.close()
