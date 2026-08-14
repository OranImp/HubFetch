"""Tests for strict repository and task specification contracts."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from pydantic import TypeAdapter, ValidationError

if TYPE_CHECKING:
    from pydantic import BaseModel

from hubfetch.domain.events import (
    TaskQueuedEvent,
    TaskRecoveredEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
)
from hubfetch.domain.ids import AttemptId, RepositoryId, TaskId
from hubfetch.domain.ipc import (
    CancelTaskCommand,
    ShutdownCommand,
    StartTaskCommand,
    WorkerReadyEvent,
    decode_wire,
    encode_wire,
)
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
    TaskSpec,
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


TASK_SPEC_ADAPTER: TypeAdapter[TaskSpec] = TypeAdapter(TaskSpec)
"""Canonical parser for direct task-specification round-trips in tests."""


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


def _start_command(spec: TaskSpec) -> StartTaskCommand:
    """Wrap one task specification in a wire start command."""
    return StartTaskCommand(
        kind="start_task",
        task_id=TaskId("task-1"),
        attempt_id=AttemptId("attempt-1"),
        spec=spec,
    )


def test_single_file_spec_round_trips_through_jsonl_when_wrapped_in_command() -> None:
    """Given a single-file spec in a start command, JSONL decoding restores it."""
    command = _start_command(_single_file_spec())

    decoded = decode_wire(encode_wire(command))

    assert decoded == command
    assert decoded.model_dump()["spec"]["filename"] == "config.json"


def test_snapshot_spec_round_trips_through_jsonl_when_wrapped_in_command() -> None:
    """Given a snapshot spec in a start command, JSONL decoding restores it."""
    command = _start_command(_snapshot_spec())

    decoded = decode_wire(encode_wire(command))

    assert decoded == command
    assert decoded.model_dump()["spec"]["include_patterns"] == ("*.json",)
    assert decoded.model_dump()["spec"]["destination"]["kind"] == "cache"


def test_git_clone_spec_round_trips_through_jsonl_when_wrapped_in_command() -> None:
    """Given a clone spec in a start command, JSONL decoding restores it."""
    command = _start_command(_git_clone_spec())

    decoded = decode_wire(encode_wire(command))

    assert decoded == command
    assert decoded.model_dump()["spec"]["destination"] == Path(
        "C:/workspaces/demo-model"
    )


def test_task_spec_union_discriminates_on_kind_when_parsed() -> None:
    """Given each spec kind payload, parsing yields the matching variant."""
    for spec in (_single_file_spec(), _snapshot_spec(), _git_clone_spec()):
        parsed = TASK_SPEC_ADAPTER.validate_json(spec.model_dump_json())

        assert parsed == spec


def test_conflict_policy_variants_round_trip_when_serialized() -> None:
    """Given every conflict policy, JSON round-trip restores the exact policy."""
    for policy in (OverwriteExisting(), PreserveExisting(), FailOnExisting()):
        spec = _single_file_spec().model_copy(update={"conflict_policy": policy})

        restored = TASK_SPEC_ADAPTER.validate_json(spec.model_dump_json())

        assert restored.model_dump()["conflict_policy"] == policy.model_dump()


def test_destination_modes_round_trip_when_serialized() -> None:
    """Given cache and local-directory modes, JSON round-trip restores them."""
    cache = CacheDestination()
    local = LocalDirectoryDestination(path=Path("D:/mirror"))

    restored_cache = TASK_SPEC_ADAPTER.validate_json(
        _single_file_spec().model_copy(update={"destination": cache}).model_dump_json()
    )
    restored_local = TASK_SPEC_ADAPTER.validate_json(
        _single_file_spec().model_copy(update={"destination": local}).model_dump_json()
    )

    assert restored_cache.model_dump()["destination"]["kind"] == "cache"
    assert restored_local.model_dump()["destination"]["path"] == Path("D:/mirror")


def test_destination_mode_rejects_cache_with_local_path_when_both_supplied() -> None:
    """Given a cache tag plus a path, the contradictory mode is rejected."""
    with pytest.raises(ValidationError):
        _ = SingleFileDownloadSpec.model_validate(
            {
                "kind": "single_file",
                "repository": _model_repo(),
                "filename": "config.json",
                "destination": {"kind": "cache", "path": "C:/out"},
                "conflict_policy": {"kind": "overwrite_existing"},
                "auth_source": "anonymous",
                "proxy_mode": "system",
            }
        )


def test_destination_mode_rejects_local_without_path_when_incomplete() -> None:
    """Given a local-directory tag without a path, parsing rejects the payload."""
    with pytest.raises(ValidationError):
        _ = LocalDirectoryDestination.model_validate({"kind": "local_directory"})


def test_specs_reject_unknown_fields_when_parsed() -> None:
    """Given an unknown field, every spec rejects it at the boundary."""
    payload = _single_file_spec().model_dump()
    payload["bogus"] = "surprise"

    with pytest.raises(ValidationError):
        _ = SingleFileDownloadSpec.model_validate(payload)


def test_specs_reject_token_payload_at_the_boundary(hf_test_secret: str) -> None:
    """Given a token key, parsing rejects it without accepting the value."""
    payload = _single_file_spec().model_dump()
    payload["token"] = hf_test_secret

    with pytest.raises(ValidationError):
        _ = SingleFileDownloadSpec.model_validate(payload)


def test_git_clone_spec_has_no_conflict_policy_field() -> None:
    """Given the clone variant, no conflict policy may exist on it."""
    assert "conflict_policy" not in GitCloneSpec.model_fields


def test_git_clone_spec_rejects_conflict_policy_when_supplied() -> None:
    """Given a non-empty clone overwrite policy, the clone spec is rejected."""
    with pytest.raises(ValidationError):
        _ = GitCloneSpec.model_validate(
            {
                "kind": "git_clone",
                "repository": _model_repo(),
                "destination": "C:/fresh",
                "auth_source": "anonymous",
                "proxy_mode": "system",
                "conflict_policy": {"kind": "overwrite_existing"},
            }
        )


def test_git_clone_spec_rejects_cache_destination_when_supplied() -> None:
    """Given a cache destination mode, the clone spec is rejected."""
    with pytest.raises(ValidationError):
        _ = GitCloneSpec.model_validate(
            {
                "kind": "git_clone",
                "repository": _model_repo(),
                "destination": {"kind": "cache"},
                "auth_source": "anonymous",
                "proxy_mode": "system",
            }
        )


def test_git_clone_spec_rejects_empty_destination_when_supplied() -> None:
    """Given an empty clone destination, parsing rejects the payload."""
    with pytest.raises(ValidationError):
        _ = GitCloneSpec.model_validate(
            {
                "kind": "git_clone",
                "repository": _model_repo(),
                "destination": "",
                "auth_source": "anonymous",
                "proxy_mode": "system",
            }
        )
