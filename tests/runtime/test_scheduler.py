"""Tests for the single-owner FIFO scheduler and its runtime owner.

# noqa: SIZE_OK - Todo 15 scopes exactly one scheduler test module that must
# enumerate the full mandatory behavior matrix (FIFO, gates, recovery, races).
"""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Thread
from typing import TYPE_CHECKING, final

import pytest

from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleEvent, LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.runtime_owner import (
    FileLockRuntimeOwner,
    RuntimeOwnerUnavailableError,
)
from hubfetch.runtime.scheduler import (
    DispatchBlocked,
    DispatchBlockReason,
    DispatchClaimed,
    DispatchResult,
    NonTerminalCompletionError,
    Scheduler,
    SchedulerAlreadyStartedError,
)
from tests.helpers.clock import ControllableClock

if TYPE_CHECKING:
    from collections.abc import Iterator

    from hubfetch.domain.ids import AttemptId, TaskId

_ABORT_TRANSITIONS_SQL: str = (
    "CREATE TRIGGER abort_transitions BEFORE INSERT ON task_events "
    "WHEN NEW.kind = 'task_transitioned' "
    "BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
)


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
    """Build one complete Git clone specification for scheduler tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=parse_repository_id("org/demo-model"), kind=ModelRepository()
        ),
        destination=destination,
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _enqueue(repository: TaskRepository, count: int, clock: ControllableClock) -> None:
    """Persist ``count`` queued tasks with deterministic identifiers."""
    for index in range(count):
        _ = clock.advance(timedelta(seconds=1))
        _ = repository.create(
            parse_task_id(f"t-{index}"),
            _make_spec(Path(f"C:/workspaces/demo-{index}")),
            parse_attempt_id(f"a-{index}"),
        )


@final
class FakeOwner:
    """In-memory owner recording acquisitions for scheduler tests."""

    def __init__(self) -> None:
        self.acquire_count = 0
        self.release_count = 0
        self.held = False

    def acquire(self) -> None:
        self.acquire_count += 1
        self.held = True

    def release(self) -> None:
        self.release_count += 1
        self.held = False


@final
class RecordingObserver:
    """Observer recording started and queue-change notifications in order."""

    def __init__(self) -> None:
        self.started: list[tuple[TaskId, AttemptId]] = []
        self.changed_count = 0

    def task_started(self, task_id: TaskId, attempt_id: AttemptId) -> None:
        self.started.append((task_id, attempt_id))

    def queue_changed(self) -> None:
        self.changed_count += 1


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    """Return the path of a fresh temporary database file."""
    return tmp_path / "hubfetch.db"


@pytest.fixture
def connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    """Yield a migrated thread-safe connection and close it afterwards."""
    connection = _open_connection(database_path)
    migrate(connection)
    yield connection
    connection.close()


@pytest.fixture
def clock() -> ControllableClock:
    """Return a deterministic clock advanced only by the test."""
    return ControllableClock()


@pytest.fixture
def repository(
    connection: sqlite3.Connection, clock: ControllableClock
) -> TaskRepository:
    """Return one repository bound to the shared connection."""
    return TaskRepository(connection, clock=clock)


def _ready_scheduler(repository: TaskRepository) -> tuple[Scheduler, RecordingObserver]:
    """Start a scheduler with both gates open over the given repository."""
    observer = RecordingObserver()
    scheduler = Scheduler(repository, owner=FakeOwner(), observer=observer)
    _ = scheduler.start()
    scheduler.mark_diagnostics_ready()
    return scheduler, observer


def _tick(scheduler: Scheduler) -> DispatchResult:
    """Run one scheduler dispatch, used by the concurrent race test."""
    return scheduler.dispatch()


def test_dispatch_blocked_before_recovery(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given a never-started scheduler, dispatch stays blocked on recovery."""
    _enqueue(repository, 1, clock)
    scheduler = Scheduler(repository, owner=FakeOwner())

    result = scheduler.dispatch()

    assert isinstance(result, DispatchBlocked)
    assert result.reason == DispatchBlockReason.RECOVERY_PENDING


def test_dispatch_blocked_until_diagnostics_gate(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given recovery done but diagnostics not ready, dispatch stays blocked."""
    _enqueue(repository, 1, clock)
    scheduler = Scheduler(repository, owner=FakeOwner())
    _ = scheduler.start()

    result = scheduler.dispatch()

    assert isinstance(result, DispatchBlocked)
    assert result.reason == DispatchBlockReason.DIAGNOSTICS_PENDING
    assert repository.list()[0].state == LifecycleState.QUEUED


def test_start_recovers_interrupted_tasks_before_any_dispatch(
    connection: sqlite3.Connection,
    clock: ControllableClock,
) -> None:
    """Given abandoned active tasks, startup interrupts them before dispatch."""
    repository = TaskRepository(connection, clock=clock)
    running = repository.create(
        parse_task_id("t-r"), _make_spec(Path("C:/r")), parse_attempt_id("a-r")
    )
    _ = repository.transition(
        running.task_id,
        expected_state=LifecycleState.QUEUED,
        event=LifecycleEvent.START,
    )
    _enqueue(repository, 1, clock)
    scheduler = Scheduler(repository, owner=FakeOwner())

    report = scheduler.start()

    assert report.recovered == (running.task_id,)
    recovered = repository.get(running.task_id)
    assert recovered is not None
    assert recovered.state == LifecycleState.INTERRUPTED
    queued = repository.get(parse_task_id("t-0"))
    assert queued is not None
    assert queued.state == LifecycleState.QUEUED


def test_start_is_refused_twice(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given a started scheduler, recovery may never run again."""
    _enqueue(repository, 1, clock)
    scheduler = Scheduler(repository, owner=FakeOwner())
    _ = scheduler.start()

    with pytest.raises(SchedulerAlreadyStartedError):
        _ = scheduler.start()


def test_close_releases_the_runtime_owner(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given a started scheduler, close releases the runtime owner."""
    _enqueue(repository, 1, clock)
    owner = FakeOwner()
    scheduler = Scheduler(repository, owner=owner)
    _ = scheduler.start()
    assert owner.acquire_count == 1

    scheduler.close()

    assert owner.release_count == 1
    assert not owner.held


def test_claims_oldest_queued_task_in_fifo_order(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given several queued tasks, dispatch claims them in FIFO order."""
    _enqueue(repository, 3, clock)
    scheduler, observer = _ready_scheduler(repository)

    first = scheduler.dispatch()
    assert isinstance(first, DispatchClaimed)
    assert first.task_id == parse_task_id("t-0")
    assert observer.started == [(parse_task_id("t-0"), parse_attempt_id("a-0"))]

    previous = "t-0"
    for expected in ("t-1", "t-2"):
        _ = scheduler.complete(
            parse_task_id(previous),
            expected_state=LifecycleState.RUNNING,
            event=LifecycleEvent.SUCCEEDED,
        )
        assert scheduler.snapshot().active[0].task_id == parse_task_id(expected)
        previous = expected

    _ = scheduler.complete(
        parse_task_id("t-2"),
        expected_state=LifecycleState.RUNNING,
        event=LifecycleEvent.SUCCEEDED,
    )
    assert scheduler.snapshot().active_count == 0


def test_fifo_order_survives_database_reopen(
    database_path: Path, clock: ControllableClock
) -> None:
    """Given a reopened database, the oldest task is still claimed first."""
    connection = _open_connection(database_path)
    migrate(connection)
    _enqueue(TaskRepository(connection, clock=clock), 3, clock)
    connection.close()

    reopened = _open_connection(database_path)
    migrate(reopened)
    scheduler = Scheduler(TaskRepository(reopened, clock=clock), owner=FakeOwner())
    _ = scheduler.start()
    scheduler.mark_diagnostics_ready()

    result = scheduler.dispatch()

    assert isinstance(result, DispatchClaimed)
    assert result.task_id == parse_task_id("t-0")
    reopened.close()


def test_race_two_scheduler_ticks_yields_single_claim(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given two concurrent ticks, exactly one task is claimed."""
    _enqueue(repository, 3, clock)
    scheduler, _ = _ready_scheduler(repository)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results: list[DispatchResult] = list(pool.map(_tick, [scheduler, scheduler]))

    claimed = [r for r in results if isinstance(r, DispatchClaimed)]
    assert len(claimed) == 1
    assert claimed[0].task_id == parse_task_id("t-0")
    assert scheduler.snapshot().active_count == 1


def test_complete_dispatches_next_only_after_terminal_commit(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given a claimed task, its terminal commit precedes the next start."""
    _enqueue(repository, 2, clock)
    scheduler, observer = _ready_scheduler(repository)
    _ = scheduler.dispatch()

    record = scheduler.complete(
        parse_task_id("t-0"),
        expected_state=LifecycleState.RUNNING,
        event=LifecycleEvent.SUCCEEDED,
    )

    assert record.state == LifecycleState.SUCCEEDED
    assert observer.started[-1] == (parse_task_id("t-1"), parse_attempt_id("a-1"))
    assert scheduler.snapshot().active[0].task_id == parse_task_id("t-1")


def test_duplicate_terminal_callback_is_idempotent(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given a completed task, a duplicate terminal callback changes nothing."""
    _enqueue(repository, 1, clock)
    scheduler, _ = _ready_scheduler(repository)
    _ = scheduler.dispatch()
    _ = scheduler.complete(
        parse_task_id("t-0"),
        expected_state=LifecycleState.RUNNING,
        event=LifecycleEvent.SUCCEEDED,
    )

    second = scheduler.complete(
        parse_task_id("t-0"),
        expected_state=LifecycleState.RUNNING,
        event=LifecycleEvent.SUCCEEDED,
    )

    assert second.state == LifecycleState.SUCCEEDED
    assert scheduler.snapshot().active_count == 0


def test_complete_rejects_non_terminal_event(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given a running task, a cancellation event is not a completion."""
    _enqueue(repository, 1, clock)
    scheduler, _ = _ready_scheduler(repository)
    _ = scheduler.dispatch()

    with pytest.raises(NonTerminalCompletionError):
        _ = scheduler.complete(
            parse_task_id("t-0"),
            expected_state=LifecycleState.RUNNING,
            event=LifecycleEvent.CANCEL,
        )

    assert scheduler.snapshot().active[0].state == LifecycleState.RUNNING


def test_terminal_transaction_failure_prevents_next_dispatch(
    connection: sqlite3.Connection,
    repository: TaskRepository,
    clock: ControllableClock,
) -> None:
    """Given an aborted completion transaction, nothing new starts."""
    _enqueue(repository, 2, clock)
    scheduler, _ = _ready_scheduler(repository)
    _ = scheduler.dispatch()
    _ = connection.execute(_ABORT_TRANSITIONS_SQL)

    with pytest.raises(sqlite3.IntegrityError):
        _ = scheduler.complete(
            parse_task_id("t-0"),
            expected_state=LifecycleState.RUNNING,
            event=LifecycleEvent.SUCCEEDED,
        )

    completed = repository.get(parse_task_id("t-0"))
    assert completed is not None
    assert completed.state == LifecycleState.RUNNING
    pending = repository.get(parse_task_id("t-1"))
    assert pending is not None
    assert pending.state == LifecycleState.QUEUED


def test_concurrent_enqueue_and_terminal_callbacks_keep_one_active(
    repository: TaskRepository, clock: ControllableClock
) -> None:
    """Given racing enqueue and completion callbacks, at most one task is active."""
    _enqueue(repository, 6, clock)
    scheduler, _ = _ready_scheduler(repository)
    observed_counts: list[int] = []

    def enqueuer() -> None:
        while True:
            snapshot = scheduler.snapshot()
            observed_counts.append(snapshot.active_count)
            if not snapshot.queued:
                return
            _ = scheduler.dispatch()

    def completer() -> None:
        while True:
            snapshot = scheduler.snapshot()
            observed_counts.append(snapshot.active_count)
            if not snapshot.queued and not snapshot.active:
                return
            if snapshot.active:
                _ = scheduler.complete(
                    snapshot.active[0].task_id,
                    expected_state=LifecycleState.RUNNING,
                    event=LifecycleEvent.SUCCEEDED,
                )

    first = Thread(target=enqueuer)
    second = Thread(target=completer)
    first.start()
    second.start()
    first.join()
    second.join()

    assert max(observed_counts) <= 1
    final = scheduler.snapshot()
    assert final.active_count == 0
    assert all(task.state == LifecycleState.SUCCEEDED for task in final.tasks)


@pytest.mark.windows
def test_second_runtime_owner_is_refused(tmp_path: Path) -> None:
    """Given a held runtime lock, a second owner is refused with a typed error."""
    first = FileLockRuntimeOwner(tmp_path / "owner.lock")
    second = FileLockRuntimeOwner(tmp_path / "owner.lock")
    first.acquire()
    try:
        with pytest.raises(RuntimeOwnerUnavailableError):
            second.acquire()
        assert not second.held
    finally:
        first.release()

    second.acquire()
    assert second.held
    second.release()
    assert not second.held
