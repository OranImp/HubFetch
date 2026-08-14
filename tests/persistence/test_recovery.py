"""Tests for idempotent startup recovery of interrupted attempts."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from hubfetch.domain.events import TaskRecoveredEvent
from hubfetch.domain.ids import (
    AttemptId,
    RepositoryId,
    TaskId,
    parse_attempt_id,
    parse_task_id,
)
from hubfetch.domain.lifecycle import LifecycleEvent, LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository

if TYPE_CHECKING:
    import sqlite3

    from tests.helpers.clock import ControllableClock


def _make_spec() -> GitCloneSpec:
    """Build one complete Git clone specification for recovery tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=RepositoryId("org/demo-model"),
            kind=ModelRepository(),
        ),
        destination=Path("C:/workspaces/demo-model"),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _active_running_task(
    repository: TaskRepository,
    name: str,
) -> tuple[TaskId, AttemptId]:
    """Create one task and start it, leaving it in the running state."""
    task = repository.create(
        parse_task_id(name), _make_spec(), parse_attempt_id(f"a-{name}")
    )
    _ = repository.transition(
        task.task_id, expected_state=LifecycleState.QUEUED, event=LifecycleEvent.START
    )
    return task.task_id, task.attempt_id


def test_recovery_converts_active_attempts_to_interrupted(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given running and cancelling tasks, recovery interrupts them only."""
    repository = TaskRepository(connection, clock=clock)
    queued = repository.create(
        parse_task_id("t-queued"), _make_spec(), parse_attempt_id("a-queued")
    )
    running_id, _ = _active_running_task(repository, "t-running")
    cancelling = repository.create(
        parse_task_id("t-cancelling"), _make_spec(), parse_attempt_id("a-cancelling")
    )
    _ = repository.transition(
        cancelling.task_id,
        expected_state=LifecycleState.QUEUED,
        event=LifecycleEvent.START,
    )
    _ = repository.transition(
        cancelling.task_id,
        expected_state=LifecycleState.RUNNING,
        event=LifecycleEvent.CANCEL,
    )

    recovered = repository.recover_interrupted()

    assert set(recovered) == {running_id, cancelling.task_id}
    queued_after = repository.get(queued.task_id)
    running_after = repository.get(running_id)
    cancelling_after = repository.get(cancelling.task_id)
    assert queued_after is not None
    assert queued_after.state == LifecycleState.QUEUED
    assert running_after is not None
    assert running_after.state == LifecycleState.INTERRUPTED
    assert cancelling_after is not None
    assert cancelling_after.state == LifecycleState.INTERRUPTED


def test_recovery_writes_one_recovery_event_per_task(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a recovered task, exactly one recovery event is recorded."""
    repository = TaskRepository(connection, clock=clock)
    running_id, _ = _active_running_task(repository, "t-running")

    _ = repository.recover_interrupted()

    recovery_events = [
        event
        for event in repository.history(running_id)
        if isinstance(event, TaskRecoveredEvent)
    ]
    assert len(recovery_events) == 1
    assert recovery_events[0].from_state == LifecycleState.RUNNING
    assert recovery_events[0].to_state == LifecycleState.INTERRUPTED


def test_recovery_is_idempotent(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a second recovery run, nothing further is recovered."""
    repository = TaskRepository(connection, clock=clock)
    running_id, _ = _active_running_task(repository, "t-running")

    first = repository.recover_interrupted()
    second = repository.recover_interrupted()

    assert first == (running_id,)
    assert second == ()
    recovery_events = [
        event
        for event in repository.history(running_id)
        if isinstance(event, TaskRecoveredEvent)
    ]
    assert len(recovery_events) == 1


def test_recovery_survives_reopen(
    database_path: Path, clock: ControllableClock
) -> None:
    """Given a reopened database, recovery still converts active attempts."""
    connection = open_connection(database_path)
    migrate(connection)
    repository = TaskRepository(connection, clock=clock)
    running_id, _ = _active_running_task(repository, "t-running")
    connection.close()

    reopened = open_connection(database_path)
    migrate(reopened)
    recovered = TaskRepository(reopened, clock=clock).recover_interrupted()

    assert recovered == (running_id,)
    reopened.close()

    again = open_connection(database_path)
    migrate(again)
    assert TaskRepository(again, clock=clock).recover_interrupted() == ()
    again.close()
