"""Tests for the transactional task repository over real SQLite files."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from hubfetch.domain.events import TaskTransitionedEvent
from hubfetch.domain.ids import RepositoryId, parse_attempt_id, parse_task_id
from hubfetch.domain.lifecycle import (
    IllegalTransitionError,
    LifecycleEvent,
    LifecycleState,
    TransferStage,
)
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.records import (
    CorruptRecordError,
    StateMismatchError,
    TaskNotFoundError,
)
from hubfetch.persistence.task_repository import TaskRepository

if TYPE_CHECKING:
    from tests.helpers.clock import ControllableClock

_ABORT_TRIGGER_SQL: str = "CREATE TRIGGER abort_events BEFORE INSERT ON task_events WHEN NEW.kind = 'task_transitioned' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"  # noqa: E501


def _make_spec(auth_source: AuthSource = AuthSource.ANONYMOUS) -> GitCloneSpec:
    """Build one complete Git clone specification for persistence tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=RepositoryId("org/demo-model"),
            kind=ModelRepository(),
            revision="v1.0.0",
        ),
        destination=Path("C:/workspaces/demo-model"),
        auth_source=auth_source,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _make_repository(
    connection: sqlite3.Connection, clock: ControllableClock
) -> TaskRepository:
    """Build one repository bound to the shared migrated connection."""
    return TaskRepository(connection, clock=clock)


def test_create_persists_task_transition_and_queued_event_atomically(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a fresh database, creating a task stores all three rows."""
    repository = _make_repository(connection, clock)
    task_id = parse_task_id("t-1")
    attempt_id = parse_attempt_id("a-1")
    spec = _make_spec()

    record = repository.create(task_id, spec, attempt_id)

    assert record.task_id == task_id
    assert record.spec == spec
    assert record.state == LifecycleState.QUEUED
    assert record.attempt_id == attempt_id
    assert record.position == 1
    assert [
        (t.from_state, t.to_state, t.event_kind)
        for t in repository.transitions(task_id)
    ] == [(LifecycleState.QUEUED, LifecycleState.QUEUED, None)]
    history = repository.history(task_id)
    assert [event.kind for event in history] == ["task_queued"]
    assert history[0].task_id == task_id
    assert history[0].attempt_id == attempt_id


def test_list_returns_fifo_queue_order(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given several tasks, listing follows persisted creation order."""
    repository = _make_repository(connection, clock)
    task_ids = tuple(parse_task_id(f"t-{index}") for index in range(3))
    for task_id in task_ids:
        _ = repository.create(task_id, _make_spec(), parse_attempt_id(f"a-{task_id}"))

    listed = repository.list()

    assert [record.task_id for record in listed] == list(task_ids)


def test_fifo_order_survives_reopen(
    database_path: Path, clock: ControllableClock
) -> None:
    """Given a closed database, reopening preserves the FIFO order."""
    connection = open_connection(database_path)
    migrate(connection)
    repository = _make_repository(connection, clock)
    task_ids = tuple(parse_task_id(f"t-{index}") for index in range(3))
    for task_id in task_ids:
        _ = repository.create(task_id, _make_spec(), parse_attempt_id(f"a-{task_id}"))
    connection.close()

    reopened = open_connection(database_path)
    migrate(reopened)
    listed = _make_repository(reopened, clock).list()

    assert [record.task_id for record in listed] == list(task_ids)
    reopened.close()


def test_cas_rejects_stale_expected_state(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a transition already applied, a stale expected state is rejected."""
    repository = _make_repository(connection, clock)
    task = repository.create(
        parse_task_id("t-1"), _make_spec(), parse_attempt_id("a-1")
    )
    _ = repository.transition(
        task.task_id, expected_state=LifecycleState.QUEUED, event=LifecycleEvent.START
    )

    with pytest.raises(StateMismatchError):
        _ = repository.transition(
            task.task_id,
            expected_state=LifecycleState.QUEUED,
            event=LifecycleEvent.START,
        )

    record = repository.get(task.task_id)
    assert record is not None
    assert record.state == LifecycleState.RUNNING


def test_illegal_transition_is_rejected_before_writing(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given an illegal state/event pair, the domain gate rejects it."""
    repository = _make_repository(connection, clock)
    task = repository.create(
        parse_task_id("t-1"), _make_spec(), parse_attempt_id("a-1")
    )
    _ = repository.transition(
        task.task_id, expected_state=LifecycleState.QUEUED, event=LifecycleEvent.START
    )

    with pytest.raises(IllegalTransitionError):
        _ = repository.transition(
            task.task_id,
            expected_state=LifecycleState.RUNNING,
            event=LifecycleEvent.CANCEL_CONFIRMED,
        )

    record = repository.get(task.task_id)
    assert record is not None
    assert record.state == LifecycleState.RUNNING


def test_injected_failure_rolls_back_entire_create(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given an aborted event insert, the whole create transaction rolls back."""
    _ = connection.execute(
        "CREATE TRIGGER abort_events BEFORE INSERT ON task_events WHEN NEW.attempt_id = 'boom' BEGIN SELECT RAISE(ABORT, 'injected failure'); END"  # noqa: E501
    )
    repository = _make_repository(connection, clock)
    task_id = parse_task_id("t-boom")

    with pytest.raises(sqlite3.IntegrityError):
        _ = repository.create(task_id, _make_spec(), parse_attempt_id("boom"))

    assert repository.get(task_id) is None
    assert repository.list() == ()


def test_injected_failure_rolls_back_lifecycle_transition(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given an aborted event insert, a transition writes nothing."""
    _ = connection.execute(_ABORT_TRIGGER_SQL)
    repository = _make_repository(connection, clock)
    task = repository.create(
        parse_task_id("t-1"), _make_spec(), parse_attempt_id("a-1")
    )

    with pytest.raises(sqlite3.IntegrityError):
        _ = repository.transition(
            task.task_id,
            expected_state=LifecycleState.QUEUED,
            event=LifecycleEvent.START,
        )

    record = repository.get(task.task_id)
    assert record is not None
    assert record.state == LifecycleState.QUEUED
    assert [event.kind for event in repository.history(task.task_id)] == ["task_queued"]


def test_record_progress_appends_sanitized_event(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a running task, progress is stored as one sanitized event."""
    repository = _make_repository(connection, clock)
    task = repository.create(
        parse_task_id("t-1"), _make_spec(), parse_attempt_id("a-1")
    )

    event = repository.record_progress(
        task.task_id,
        attempt_id=parse_attempt_id("a-1"),
        stage=TransferStage.TRANSFER,
        bytes_done=10,
        bytes_total=100,
    )

    assert event.kind == "transfer_progressed"
    assert event.bytes_done == 10
    assert event.bytes_total == 100
    assert [item.kind for item in repository.history(task.task_id)] == [
        "task_queued",
        "transfer_progressed",
    ]


def test_record_progress_on_missing_task_raises(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given an unknown task id, progress recording fails with a typed error."""
    repository = _make_repository(connection, clock)

    with pytest.raises(TaskNotFoundError):
        _ = repository.record_progress(
            parse_task_id("t-missing"),
            attempt_id=parse_attempt_id("a-1"),
            stage=TransferStage.PREFLIGHT,
            bytes_done=0,
            bytes_total=0,
        )


def test_history_parses_through_domain_models(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given stored events, history returns typed domain models in order."""
    repository = _make_repository(connection, clock)
    task = repository.create(
        parse_task_id("t-1"), _make_spec(), parse_attempt_id("a-1")
    )
    _ = repository.transition(
        task.task_id, expected_state=LifecycleState.QUEUED, event=LifecycleEvent.START
    )

    history = repository.history(task.task_id)

    assert [event.kind for event in history] == ["task_queued", "task_transitioned"]
    transition_event = history[1]
    assert isinstance(transition_event, TaskTransitionedEvent)
    assert transition_event.from_state == LifecycleState.QUEUED
    assert transition_event.to_state == LifecycleState.RUNNING


def test_corrupt_event_payload_raises_typed_error(
    connection: sqlite3.Connection, clock: ControllableClock
) -> None:
    """Given a corrupted stored event, history fails with a typed error."""
    repository = _make_repository(connection, clock)
    task = repository.create(
        parse_task_id("t-1"), _make_spec(), parse_attempt_id("a-1")
    )
    _ = connection.execute(
        "UPDATE task_events SET payload = ? WHERE task_id = ?",
        ("{not canonical json", task.task_id),
    )

    with pytest.raises(CorruptRecordError):
        _ = repository.history(task.task_id)


def test_database_bytes_never_contain_credential_sentinel(
    database_path: Path, clock: ControllableClock, hf_test_secret: str
) -> None:
    """Given a manual-token task, the sentinel never reaches DB or WAL bytes."""
    connection = open_connection(database_path)
    migrate(connection)
    repository = _make_repository(connection, clock)
    _ = repository.create(
        parse_task_id("t-1"),
        _make_spec(auth_source=AuthSource.MANUAL_TOKEN),
        parse_attempt_id("a-1"),
    )

    wal_path = database_path.with_name(database_path.name + "-wal")
    db_bytes = database_path.read_bytes()
    wal_bytes = wal_path.read_bytes() if wal_path.exists() else b""
    connection.close()

    assert hf_test_secret.encode() not in db_bytes
    assert hf_test_secret.encode() not in wal_bytes
