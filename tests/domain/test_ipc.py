"""Tests for the canonical newline-delimited JSON wire encoding."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pydantic import BaseModel

from hubfetch.domain.events import (
    PersistedEvent,
    TaskQueuedEvent,
    TaskRecoveredEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
)
from hubfetch.domain.ids import AttemptId, EventId, RepositoryId, TaskId
from hubfetch.domain.ipc import (
    CancelledEvent,
    CancelTaskCommand,
    FailedEvent,
    GuiCommand,
    ProgressEvent,
    ShutdownCommand,
    StageChangedEvent,
    StartTaskCommand,
    SucceededEvent,
    WireMessage,
    WorkerEvent,
    WorkerReadyEvent,
    decode_wire,
    encode_wire,
)
from hubfetch.domain.lifecycle import (
    LifecycleState,
    TerminalResult,
    TransferStage,
)
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)

WIRE_MODELS: tuple[type[BaseModel], ...] = (
    StartTaskCommand,
    CancelTaskCommand,
    ShutdownCommand,
    WorkerReadyEvent,
    StageChangedEvent,
    ProgressEvent,
    SucceededEvent,
    FailedEvent,
    CancelledEvent,
    TaskQueuedEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
    TaskRecoveredEvent,
)

TIMESTAMP = datetime(2026, 1, 1, 12, 30, 0, tzinfo=UTC)


def _single_file_spec() -> SingleFileDownloadSpec:
    """Build the smallest complete download specification."""
    return SingleFileDownloadSpec(
        kind="single_file",
        repository=RepositoryRef(
            repo_id=RepositoryId("org/demo"),
            kind=ModelRepository(),
        ),
        filename="config.json",
        destination=CacheDestination(),
        conflict_policy=OverwriteExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _all_gui_commands() -> tuple[GuiCommand, ...]:
    """Return one instance of every GUI command variant."""
    return (
        StartTaskCommand(
            kind="start_task",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            spec=_single_file_spec(),
        ),
        CancelTaskCommand(
            kind="cancel_task",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
        ),
        ShutdownCommand(kind="shutdown"),
    )


def _all_worker_events() -> tuple[WorkerEvent, ...]:
    """Return one instance of every worker event variant."""
    return (
        WorkerReadyEvent(kind="worker_ready"),
        StageChangedEvent(
            kind="stage_changed",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            stage=TransferStage.TRANSFER,
        ),
        ProgressEvent(
            kind="progress",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            bytes_done=10,
            bytes_total=100,
        ),
        SucceededEvent(
            kind="succeeded",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            terminal_result=TerminalResult.SUCCEEDED,
        ),
        FailedEvent(
            kind="failed",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            terminal_result=TerminalResult.FAILED,
            error_code="network_timeout",
        ),
        CancelledEvent(
            kind="cancelled",
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            terminal_result=TerminalResult.CANCELLED,
        ),
    )


def _all_persisted_events() -> tuple[PersistedEvent, ...]:
    """Return one instance of every persisted event variant."""
    return (
        TaskQueuedEvent(
            kind="task_queued",
            event_id=EventId("event-1"),
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            occurred_at=TIMESTAMP,
        ),
        TaskTransitionedEvent(
            kind="task_transitioned",
            event_id=EventId("event-2"),
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            occurred_at=TIMESTAMP,
            from_state=LifecycleState.QUEUED,
            to_state=LifecycleState.RUNNING,
        ),
        TransferProgressedEvent(
            kind="transfer_progressed",
            event_id=EventId("event-3"),
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            occurred_at=TIMESTAMP,
            stage=TransferStage.TRANSFER,
            bytes_done=10,
            bytes_total=100,
        ),
        TaskRecoveredEvent(
            kind="task_recovered",
            event_id=EventId("event-4"),
            task_id=TaskId("task-1"),
            attempt_id=AttemptId("attempt-1"),
            occurred_at=TIMESTAMP,
            from_state=LifecycleState.RUNNING,
            to_state=LifecycleState.INTERRUPTED,
        ),
    )


def _all_wire_messages() -> tuple[WireMessage, ...]:
    """Return every wire model variant across commands, events, and records."""
    return (
        *_all_gui_commands(),
        *_all_worker_events(),
        *_all_persisted_events(),
    )


def test_every_gui_command_round_trips_through_jsonl() -> None:
    """Given every GUI command, JSONL encoding and decoding restores it."""
    for command in _all_gui_commands():
        decoded = decode_wire(encode_wire(command))

        assert decoded == command
        assert decoded.kind == command.kind


def test_every_worker_event_round_trips_through_jsonl() -> None:
    """Given every worker event, JSONL encoding and decoding restores it."""
    for event in _all_worker_events():
        decoded = decode_wire(encode_wire(event))

        assert decoded == event
        assert decoded.kind == event.kind


def test_every_persisted_event_round_trips_through_jsonl() -> None:
    """Given every persisted event, JSONL encoding and decoding restores it."""
    for event in _all_persisted_events():
        decoded = decode_wire(encode_wire(event))

        assert decoded == event
        assert decoded.kind == event.kind


def test_terminal_results_survive_wire_round_trip() -> None:
    """Given terminal worker events, the terminal result field is preserved."""
    for result in (TerminalResult.SUCCEEDED, TerminalResult.FAILED):
        event = (
            SucceededEvent(
                kind="succeeded",
                task_id=TaskId("task-1"),
                attempt_id=AttemptId("attempt-1"),
                terminal_result=result,
            )
            if result == TerminalResult.SUCCEEDED
            else FailedEvent(
                kind="failed",
                task_id=TaskId("task-1"),
                attempt_id=AttemptId("attempt-1"),
                terminal_result=result,
                error_code="network_timeout",
            )
        )

        decoded = decode_wire(encode_wire(event))

        assert decoded.model_dump()["terminal_result"] == result.value


def test_encode_wire_produces_one_json_line_per_message() -> None:
    """Given any wire message, the encoder emits a single JSONL line."""
    for message in _all_wire_messages():
        line = encode_wire(message)

        assert line.endswith("\n")
        assert "\n" not in line[:-1]


def test_all_serialized_wire_messages_never_contain_secret_bytes() -> None:
    """Given every wire message, no JSONL output contains the sentinel."""
    serialized = b"".join(
        encode_wire(message).encode("utf-8") for message in _all_wire_messages()
    )

    assert b"hf_test_secret_123" not in serialized


def test_wire_models_have_no_secret_field_names() -> None:
    """Given every wire model, credential-like field names are absent."""
    forbidden = {"token", "password", "secret", "api_key"}

    for model in WIRE_MODELS:
        assert forbidden.isdisjoint(model.model_fields)
