"""Tests for application-level create, cancel, retry, and snapshots."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from hubfetch.application.task_service import (
    RetryDestinationNotReadyError,
    RetryResult,
    TaskAlreadyExistsError,
    TaskService,
)
from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.lifecycle import (
    LifecycleEvent,
    LifecycleState,
    RetryNotAllowedError,
)
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.records import StateMismatchError, TaskNotFoundError
from hubfetch.persistence.task_repository import TaskRepository
from tests.helpers.clock import ControllableClock

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator

    from hubfetch.domain.ids import TaskId


def _make_spec(destination: Path) -> GitCloneSpec:
    """Build one complete Git clone specification for service tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=parse_repository_id("org/demo-model"), kind=ModelRepository()
        ),
        destination=destination,
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _drive_to_state(
    repository: TaskRepository, task_id: TaskId, state: LifecycleState
) -> None:
    """Walk one task through the legal transition path into the given state."""
    steps = {
        LifecycleState.RUNNING: ((LifecycleState.QUEUED, LifecycleEvent.START),),
        LifecycleState.CANCELLED: ((LifecycleState.QUEUED, LifecycleEvent.CANCEL),),
        LifecycleState.CANCELLING: (
            (LifecycleState.QUEUED, LifecycleEvent.START),
            (LifecycleState.RUNNING, LifecycleEvent.CANCEL),
        ),
        LifecycleState.SUCCEEDED: (
            (LifecycleState.QUEUED, LifecycleEvent.START),
            (LifecycleState.RUNNING, LifecycleEvent.SUCCEEDED),
        ),
        LifecycleState.FAILED: (
            (LifecycleState.QUEUED, LifecycleEvent.START),
            (LifecycleState.RUNNING, LifecycleEvent.FAILED),
        ),
        LifecycleState.INTERRUPTED: (
            (LifecycleState.QUEUED, LifecycleEvent.START),
            (LifecycleState.RUNNING, LifecycleEvent.INTERRUPTED),
        ),
    }[state]
    for expected_state, event in steps:
        _ = repository.transition(task_id, expected_state=expected_state, event=event)


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    """Return the path of a fresh temporary database file."""
    return tmp_path / "hubfetch.db"


@pytest.fixture
def connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    """Yield a migrated connection and close it afterwards."""
    connection = open_connection(database_path)
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


@pytest.fixture
def service(repository: TaskRepository) -> TaskService:
    """Return one application service bound to the repository."""
    return TaskService(repository)


def test_create_persists_confirmed_task_as_queued(service: TaskService) -> None:
    """Given a confirmed task, it persists atomically as queued."""
    spec = _make_spec(Path("C:/workspaces/demo-model"))

    record = service.create(parse_task_id("t-1"), spec, parse_attempt_id("a-1"))

    assert record.state == LifecycleState.QUEUED
    assert record.spec == spec
    snapshot = service.snapshot()
    assert [task.task_id for task in snapshot.tasks] == [parse_task_id("t-1")]
    assert snapshot.active_count == 0
    assert snapshot.queued[0].task_id == parse_task_id("t-1")


def test_create_duplicate_task_is_rejected(service: TaskService) -> None:
    """Given an existing task id, a second create is a typed error."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )

    with pytest.raises(TaskAlreadyExistsError):
        _ = service.create(
            parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-2")
        )


def test_cancel_queued_task_persists_cancelled_with_zero_worker_calls(
    service: TaskService,
) -> None:
    """Given a queued task, cancel persists cancelled without a worker."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )

    record = service.cancel(parse_task_id("t-1"))

    assert record.state == LifecycleState.CANCELLED
    history = service.detail(parse_task_id("t-1")).events
    assert [event.kind for event in history] == ["task_queued", "task_transitioned"]
    snapshot = service.snapshot()
    assert snapshot.active_count == 0
    assert snapshot.queued == ()


def test_cancel_running_task_is_rejected(
    repository: TaskRepository, service: TaskService
) -> None:
    """Given a running task, queued-cancel is refused with a typed error."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )
    _drive_to_state(repository, parse_task_id("t-1"), LifecycleState.RUNNING)

    with pytest.raises(StateMismatchError):
        _ = service.cancel(parse_task_id("t-1"))


def test_cancel_missing_task_is_rejected(service: TaskService) -> None:
    """Given an unknown task id, cancel raises a typed not-found error."""
    with pytest.raises(TaskNotFoundError):
        _ = service.cancel(parse_task_id("t-missing"))


@pytest.mark.parametrize(
    "terminal_state",
    [LifecycleState.FAILED, LifecycleState.CANCELLED, LifecycleState.INTERRUPTED],
)
def test_retry_terminal_task_appends_linked_attempt_to_fifo_end(
    repository: TaskRepository,
    service: TaskService,
    terminal_state: LifecycleState,
) -> None:
    """Given a retryable terminal task, retry appends a linked queued attempt."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )
    _ = service.create(
        parse_task_id("t-2"), _make_spec(Path("C:/x")), parse_attempt_id("a-2")
    )
    _drive_to_state(repository, parse_task_id("t-1"), terminal_state)

    result = service.retry(
        parse_task_id("t-1"), new_attempt_id=parse_attempt_id("a-r1")
    )

    assert isinstance(result, RetryResult)
    assert result.linked_from == parse_attempt_id("a-1")
    assert result.position == 3
    appended = service.detail(result.task_id)
    assert appended.task.state == LifecycleState.QUEUED
    assert appended.task.spec == _make_spec(Path("C:/w"))
    assert [task.task_id for task in service.snapshot().tasks][-1] == result.task_id


def test_retry_succeeded_task_is_rejected(
    repository: TaskRepository, service: TaskService
) -> None:
    """Given a succeeded task, retry is refused with a typed error."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )
    _drive_to_state(repository, parse_task_id("t-1"), LifecycleState.SUCCEEDED)

    with pytest.raises(RetryNotAllowedError):
        _ = service.retry(parse_task_id("t-1"), new_attempt_id=parse_attempt_id("a-r1"))


def test_retry_queued_task_is_rejected(service: TaskService) -> None:
    """Given an in-flight queued task, retry is refused with a typed error."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )

    with pytest.raises(RetryNotAllowedError):
        _ = service.retry(parse_task_id("t-1"), new_attempt_id=parse_attempt_id("a-r1"))


def test_retry_missing_task_is_rejected(service: TaskService) -> None:
    """Given an unknown task id, retry raises a typed not-found error."""
    with pytest.raises(TaskNotFoundError):
        _ = service.retry(
            parse_task_id("t-missing"), new_attempt_id=parse_attempt_id("a-r1")
        )


@pytest.mark.parametrize("populated", [True, False])
def test_retry_git_clone_destination_rule(
    tmp_path: Path,
    repository: TaskRepository,
    service: TaskService,
    populated: bool,
) -> None:
    """Given an occupied destination, retry is refused; empty or new passes."""
    destination = tmp_path / "dest"
    if populated:
        destination.mkdir()
        _ = (destination / "partial.txt").write_text("partial", encoding="utf-8")
    _ = service.create(
        parse_task_id("t-1"), _make_spec(destination), parse_attempt_id("a-1")
    )
    _drive_to_state(repository, parse_task_id("t-1"), LifecycleState.FAILED)

    if populated:
        with pytest.raises(RetryDestinationNotReadyError):
            _ = service.retry(
                parse_task_id("t-1"), new_attempt_id=parse_attempt_id("a-r1")
            )
        return

    result = service.retry(
        parse_task_id("t-1"), new_attempt_id=parse_attempt_id("a-r1")
    )
    assert service.detail(result.task_id).task.state == LifecycleState.QUEUED


def test_queue_snapshot_preserves_fifo_order_and_counts(service: TaskService) -> None:
    """Given several tasks, the snapshot keeps FIFO order and active counts."""
    for index in range(3):
        _ = service.create(
            parse_task_id(f"t-{index}"),
            _make_spec(Path(f"C:/workspaces/demo-{index}")),
            parse_attempt_id(f"a-{index}"),
        )

    snapshot = service.snapshot()

    assert [task.task_id for task in snapshot.tasks] == [
        parse_task_id(f"t-{index}") for index in range(3)
    ]
    assert snapshot.active_count == 0
    assert len(snapshot.queued) == 3


def test_detail_snapshot_includes_transitions_and_events(
    repository: TaskRepository, service: TaskService
) -> None:
    """Given a task with history, detail exposes transitions and events."""
    _ = service.create(
        parse_task_id("t-1"), _make_spec(Path("C:/w")), parse_attempt_id("a-1")
    )
    _drive_to_state(repository, parse_task_id("t-1"), LifecycleState.RUNNING)

    detail = service.detail(parse_task_id("t-1"))

    assert detail.task.state == LifecycleState.RUNNING
    assert [(t.from_state, t.to_state) for t in detail.transitions] == [
        (LifecycleState.QUEUED, LifecycleState.QUEUED),
        (LifecycleState.QUEUED, LifecycleState.RUNNING),
    ]
    assert [event.kind for event in detail.events] == [
        "task_queued",
        "task_transitioned",
    ]


def test_detail_missing_task_is_rejected(service: TaskService) -> None:
    """Given an unknown task id, detail raises a typed not-found error."""
    with pytest.raises(TaskNotFoundError):
        _ = service.detail(parse_task_id("t-missing"))
