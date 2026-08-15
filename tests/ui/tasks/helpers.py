"""Typed snapshot/event builders shared by the task inspection tests.

All builders construct immutable domain values directly, so the tests never
need a live runtime or a worker subprocess; they exercise the UI seams against
deterministic snapshot streams.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from hubfetch.application.snapshots import DetailSnapshot, QueueSnapshot, TaskSnapshot
from hubfetch.config.settings import Locale
from hubfetch.domain.events import (
    TaskQueuedEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
)
from hubfetch.domain.ids import (
    AttemptId,
    EventId,
    TaskId,
    parse_repository_id,
)
from hubfetch.domain.lifecycle import LifecycleState, TransferStage
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    GitCloneSpec,
    LocalDirectoryDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
    TaskSpec,
)
from hubfetch.ui.tasks.texts import TaskTexts

if TYPE_CHECKING:
    from hubfetch.domain.events import PersistedEvent

T0: datetime = datetime(2026, 8, 15, 10, 0, 0, tzinfo=UTC)

STATE_KINDS: dict[LifecycleState, str] = {
    LifecycleState.QUEUED: "queued",
    LifecycleState.RUNNING: "running",
    LifecycleState.CANCELLING: "cancelling",
    LifecycleState.SUCCEEDED: "succeeded",
    LifecycleState.FAILED: "failed",
    LifecycleState.CANCELLED: "cancelled",
    LifecycleState.INTERRUPTED: "interrupted",
}


def repo_ref(repo_id: str = "org/model") -> RepositoryRef:
    """Build one model repository reference."""
    return RepositoryRef(repo_id=parse_repository_id(repo_id), kind=ModelRepository())


def single_file_spec(repo_id: str = "org/model") -> SingleFileDownloadSpec:
    """Build one single-file download spec into a local directory."""
    return SingleFileDownloadSpec(
        repository=repo_ref(repo_id),
        filename="model.safetensors",
        destination=LocalDirectoryDestination(path=Path("E:\\downloads")),
        conflict_policy=OverwriteExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def git_spec(destination: str = "E:\\clone") -> GitCloneSpec:
    """Build one Git clone spec with the given destination path."""
    return GitCloneSpec(
        repository=repo_ref("org/repo"),
        destination=Path(destination),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def cache_spec(repo_id: str = "org/model") -> SingleFileDownloadSpec:
    """Build one single-file download spec into the Hub cache."""
    return SingleFileDownloadSpec(
        repository=repo_ref(repo_id),
        filename="model.safetensors",
        destination=CacheDestination(),
        conflict_policy=OverwriteExisting(),
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def snapshot(
    task_id: TaskId,
    state: LifecycleState,
    *,
    attempt_id: AttemptId | None = None,
    spec: TaskSpec | None = None,
    position: int = 0,
) -> TaskSnapshot:
    """Build one immutable task snapshot for the current state."""
    return TaskSnapshot(
        task_id=task_id,
        attempt_id=attempt_id or _attempt(task_id),
        state=state,
        spec=spec if spec is not None else single_file_spec(),
        position=position,
        created_at=T0,
        updated_at=T0,
    )


def queue(*tasks: TaskSnapshot) -> QueueSnapshot:
    """Build an immutable queue from ordered task snapshots."""
    return QueueSnapshot(tasks=tasks)


def transition_event(
    task_id: TaskId, from_state: LifecycleState, to_state: LifecycleState
) -> TaskTransitionedEvent:
    """Build one typed transition event."""
    return TaskTransitionedEvent(
        event_id=EventId(f"ev-{task_id}-{to_state.value}"),
        task_id=task_id,
        attempt_id=_attempt(task_id),
        occurred_at=T0,
        from_state=from_state,
        to_state=to_state,
    )


def queued_event(task_id: TaskId) -> TaskQueuedEvent:
    """Build the queued marker event."""
    return TaskQueuedEvent(
        event_id=EventId(f"ev-{task_id}-queued"),
        task_id=task_id,
        attempt_id=_attempt(task_id),
        occurred_at=T0,
    )


def progress_event(
    task_id: TaskId,
    bytes_done: int,
    bytes_total: int,
    *,
    stage: TransferStage = TransferStage.TRANSFER,
    delta_seconds: int = 1,
) -> TransferProgressedEvent:
    """Build one transfer progress event with a deterministic clock offset."""
    return TransferProgressedEvent(
        event_id=EventId(f"ev-{task_id}-{bytes_done}"),
        task_id=task_id,
        attempt_id=_attempt(task_id),
        occurred_at=T0 + timedelta(seconds=delta_seconds),
        stage=stage,
        bytes_done=bytes_done,
        bytes_total=bytes_total,
    )


def detail(
    task: TaskSnapshot,
    events: tuple[PersistedEvent, ...] = (),
) -> DetailSnapshot:
    """Build an immutable detail snapshot with zero transitions."""
    return DetailSnapshot(task=task, transitions=(), events=events)


def texts(locale: Locale = Locale.ZH_CN) -> TaskTexts:
    """Return the task texts vocabulary for one locale."""
    return TaskTexts.for_locale(locale)


def _attempt(task_id: TaskId) -> AttemptId:
    """Derive a stable attempt id from the task id."""
    return AttemptId(f"{task_id}-a1")
