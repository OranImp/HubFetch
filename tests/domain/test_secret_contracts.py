"""Tests for sentinel byte absence and credential-free field contracts."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pydantic import BaseModel

from hubfetch.domain.events import (
    TaskQueuedEvent,
    TaskRecoveredEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
)
from hubfetch.domain.ids import AttemptId, EventId, RepositoryId, TaskId
from hubfetch.domain.ipc import (
    CancelTaskCommand,
    ShutdownCommand,
    StartTaskCommand,
    WorkerReadyEvent,
)
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryRef,
    SpaceRepository,
)
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    FailOnExisting,
    GitCloneSpec,
    LocalDirectoryDestination,
    OverwriteExisting,
    PreserveExisting,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)

WIRE_MODELS: tuple[type[BaseModel], ...] = (
    ModelRepository,
    DatasetRepository,
    SpaceRepository,
    RepositoryRef,
    OverwriteExisting,
    PreserveExisting,
    FailOnExisting,
    CacheDestination,
    LocalDirectoryDestination,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
    GitCloneSpec,
    TaskQueuedEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
    TaskRecoveredEvent,
    StartTaskCommand,
    CancelTaskCommand,
    ShutdownCommand,
    WorkerReadyEvent,
)


def _model_repo(revision: str | None = None) -> RepositoryRef:
    """Build one model repository reference with an optional revision."""
    return RepositoryRef(
        repo_id=RepositoryId("org/demo-model"),
        kind=ModelRepository(),
        revision=revision,
    )


def _single_file_spec() -> SingleFileDownloadSpec:
    """Build a complete single-file download specification."""
    return SingleFileDownloadSpec(
        kind="single_file",
        repository=_model_repo(),
        filename="config.json",
        destination=LocalDirectoryDestination(path=Path("C:/out")),
        conflict_policy=OverwriteExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def _snapshot_spec() -> SnapshotDownloadSpec:
    """Build a complete snapshot download specification."""
    return SnapshotDownloadSpec(
        kind="snapshot",
        repository=_model_repo(revision="main"),
        include_patterns=("*.json",),
        exclude_patterns=("*.md",),
        destination=CacheDestination(),
        conflict_policy=PreserveExisting(),
        auth_source=AuthSource.SHARED_OAUTH,
        proxy_mode=ProxyMode.DIRECT,
    )


def _git_clone_spec() -> GitCloneSpec:
    """Build a complete Git clone specification without any conflict policy."""
    return GitCloneSpec(
        kind="git_clone",
        repository=_model_repo(revision="v1.0.0"),
        destination=Path("C:/workspaces/demo-model"),
        auth_source=AuthSource.MANUAL_TOKEN,
        proxy_mode=ProxyMode.MANUAL,
    )


def test_serialized_outputs_never_contain_secret_bytes() -> None:
    """Given every variant, no serialized output contains the sentinel secret."""
    variants = (
        _single_file_spec(),
        _snapshot_spec(),
        _git_clone_spec(),
        CacheDestination(),
        LocalDirectoryDestination(path=Path("C:/x")),
        OverwriteExisting(),
        PreserveExisting(),
        FailOnExisting(),
        ModelRepository(),
        DatasetRepository(),
        SpaceRepository(),
        RepositoryRef(repo_id=RepositoryId("org/demo"), kind=ModelRepository()),
    )

    serialized = b"".join(
        variant.model_dump_json().encode("utf-8") for variant in variants
    )

    assert b"hf_test_secret_123" not in serialized


def test_wire_and_spec_models_have_no_secret_field_names() -> None:
    """Given every wire model, credential-like field names are absent."""
    forbidden = {"token", "password", "secret", "api_key"}

    for model in WIRE_MODELS:
        assert forbidden.isdisjoint(model.model_fields)


def test_transition_event_carries_typed_stage_and_result_fields() -> None:
    """Given a transition event, persisted fields keep lifecycle typing."""
    event = TaskTransitionedEvent(
        event_id=EventId("event-1"),
        task_id=TaskId("task-1"),
        attempt_id=AttemptId("attempt-1"),
        occurred_at=datetime(2026, 1, 1, tzinfo=UTC),
        kind="task_transitioned",
        from_state=LifecycleState.RUNNING,
        to_state=LifecycleState.SUCCEEDED,
    )

    restored = TaskTransitionedEvent.model_validate_json(event.model_dump_json())

    assert restored.from_state == LifecycleState.RUNNING
    assert restored.to_state == LifecycleState.SUCCEEDED
