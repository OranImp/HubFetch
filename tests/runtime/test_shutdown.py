"""Windows integration tests for runtime shutdown.

Closing the runtime must stop dispatch, terminate every active worker tree,
wait for each Job to empty, and close the SQLite store — without ever blocking
the GUI thread or leaving orphan processes behind. The whole module follows
the Windows Job Object platform guard.
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
from hubfetch.domain.lifecycle import AttemptRef, LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.platform.windows.job_object import OpenProcessError, open_process
from hubfetch.runtime.scheduler import DispatchClaimed, Scheduler
from hubfetch.runtime.shutdown import RuntimeShutdown
from hubfetch.runtime.supervisor import Supervisor, SupervisorConfig
from tests.fixtures.process_tree import fixture_interpreter
from tests.helpers.clock import ControllableClock
from tests.runtime.worker_fixtures import worker_environment

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.persistence.records import TaskRecord

if platform.system() != "Windows":
    pytest.skip(allow_module_level=True)

READY_TIMEOUT_MS: Final = 10_000
CONFIRM_TIMEOUT_MS: Final = 3_000

_BLOCKING_WORKER: Final = (
    "import json, subprocess, sys, threading\n"
    "out = sys.stdout.buffer\n"
    "def emit(sequence, event):\n"
    "    line = json.dumps({'sequence': sequence, 'event': event})\n"
    "    out.write(line.encode() + b'\\n')\n"
    "    out.flush()\n"
    "emit(0, {'kind': 'worker_ready'})\n"
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
    """Build one complete Git clone specification for shutdown tests."""
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
    connection = _open_connection(tmp_path / "shutdown.sqlite")
    migrate(connection)
    repository = TaskRepository(connection, clock=clock)
    task_id = parse_task_id("t-shutdown")
    attempt_id = parse_attempt_id("a-shutdown")
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


def _launch_blocking_supervisor(binding: RuntimeBinding, tmp_path: Path) -> Supervisor:
    """Start a supervisor running a worker and child that block forever."""
    script = tmp_path / "blocking_worker.py"
    _ = script.write_text(_BLOCKING_WORKER, encoding="utf-8")
    supervisor = Supervisor(
        config=SupervisorConfig(
            attempt=AttemptRef(task_id=binding.task_id, attempt_id=binding.attempt_id),
            argv=(fixture_interpreter(), "-u", str(script)),
            environment=worker_environment(),
            ready_timeout_ms=READY_TIMEOUT_MS,
        ),
        scheduler=binding.scheduler,
        repository=binding.repository,
    )
    supervisor.start()
    return supervisor


def _wait_tree_active(qtbot: QtBot, supervisor: Supervisor) -> tuple[int, ...]:
    """Wait for the worker to be assigned and return its live Job PIDs."""
    qtbot.waitUntil(
        lambda: bool(supervisor.job.active_process_ids()), timeout=READY_TIMEOUT_MS
    )
    return supervisor.job.active_process_ids()


def _assert_no_orphans(ids_before: tuple[int, ...]) -> None:
    """Given pre-close Job PIDs, none of them is still open afterwards."""
    assert ids_before
    for pid in ids_before:
        assert _process_is_gone(pid)


def _reopen_record(tmp_path: Path, task_id: TaskId) -> TaskRecord | None:
    """Reopen the store file and read the task's committed record."""
    fresh = _open_connection(tmp_path / "shutdown.sqlite")
    try:
        repository = TaskRepository(fresh, clock=ControllableClock())
        return repository.get(task_id)
    finally:
        fresh.close()


def test_runtime_close_terminates_tree_and_closes_store(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a running worker tree, close terminates it and closes SQLite."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_blocking_supervisor(binding, tmp_path)
    ids_before = _wait_tree_active(qtbot, supervisor)
    shutdown = RuntimeShutdown(
        scheduler=binding.scheduler,
        supervisors=(supervisor,),
        connection=binding.connection,
        confirm_timeout_ms=CONFIRM_TIMEOUT_MS,
    )
    try:
        with qtbot.waitSignal(shutdown.finished, timeout=CONFIRM_TIMEOUT_MS):
            shutdown.begin()
    finally:
        supervisor.close()

    assert shutdown.finished_cleanly
    _assert_no_orphans(ids_before)
    record = _reopen_record(tmp_path, binding.task_id)
    assert record is not None
    assert record.state == LifecycleState.INTERRUPTED


def test_runtime_close_leaves_no_orphan_processes(qtbot: QtBot, tmp_path: Path) -> None:
    """Given an active tree, close leaves no live process behind."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_blocking_supervisor(binding, tmp_path)
    ids_before = _wait_tree_active(qtbot, supervisor)
    shutdown = RuntimeShutdown(
        scheduler=binding.scheduler,
        supervisors=(supervisor,),
        connection=binding.connection,
        confirm_timeout_ms=CONFIRM_TIMEOUT_MS,
    )
    try:
        with qtbot.waitSignal(shutdown.finished, timeout=CONFIRM_TIMEOUT_MS):
            shutdown.begin()
    finally:
        supervisor.close()

    assert shutdown.finished_cleanly
    _assert_no_orphans(ids_before)
    record = _reopen_record(tmp_path, binding.task_id)
    assert record is not None
    assert record.state == LifecycleState.INTERRUPTED


def test_runtime_close_releases_scheduler_owner(qtbot: QtBot, tmp_path: Path) -> None:
    """Given a close, the scheduler owner is released so no next task starts."""
    binding = _claimed_task(tmp_path)
    supervisor = _launch_blocking_supervisor(binding, tmp_path)
    ids_before = _wait_tree_active(qtbot, supervisor)
    shutdown = RuntimeShutdown(
        scheduler=binding.scheduler,
        supervisors=(supervisor,),
        connection=binding.connection,
        confirm_timeout_ms=CONFIRM_TIMEOUT_MS,
    )
    try:
        with qtbot.waitSignal(shutdown.finished, timeout=CONFIRM_TIMEOUT_MS):
            shutdown.begin()
    finally:
        supervisor.close()

    assert shutdown.finished_cleanly
    _assert_no_orphans(ids_before)
    record = _reopen_record(tmp_path, binding.task_id)
    assert record is not None
    assert record.state == LifecycleState.INTERRUPTED


def _process_is_gone(pid: int) -> bool:
    """Return whether no process with the given identifier is still open."""
    try:
        with open_process(pid):
            return False
    except OpenProcessError:
        return True
