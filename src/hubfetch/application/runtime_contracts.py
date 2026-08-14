"""Typed contracts of the application runtime facade.

Pure value types and timing bounds shared by the composition root, the
``Runtime`` facade, and the UI layer. Keeping them in one contracts module
lets the facade own only the QObject lifecycle wiring and keeps every typed
surface of the runtime documented in one place.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, override

from hubfetch.runtime.worker_process_types import DEFAULT_READY_TIMEOUT_MS

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Mapping
    from pathlib import Path

    from hubfetch.config.settings import Settings
    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.domain.ids import TaskId
    from hubfetch.domain.lifecycle import LifecycleState
    from hubfetch.persistence.task_repository import TaskRepository
    from hubfetch.runtime.runtime_owner import RuntimeOwner

DEFAULT_GRACE_PERIOD_MS: Final = 2_000
DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS: Final = 10_000
DEFAULT_SHUTDOWN_CONFIRM_TIMEOUT_MS: Final = 10_000


@dataclass(frozen=True, slots=True)
class WorkerEnvOverrides:
    """Non-secret environment seams injected into every worker environment.

    These are the documented test/portable override points: a deterministic Hub
    endpoint and cache root for fixtures, an opaque credential alias for
    manual-token auth, and an isolated Git config redirect for local clone
    fixtures. No token value ever travels through any of these seams.
    """

    hub_endpoint: str | None = None
    hub_cache_dir: Path | None = None
    credential_alias: CredentialAlias | None = None
    git_config_global: Path | None = None
    git_config_nosystem: bool = False


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    """Typed collaborators and timing bounds for one runtime instance."""

    repository: TaskRepository
    owner: RuntimeOwner
    connection: sqlite3.Connection
    settings: Settings
    parent_environment: Mapping[str, str]
    worker_command_prefix: tuple[str, ...]
    worker_overrides: WorkerEnvOverrides = WorkerEnvOverrides()
    ready_timeout_ms: int = DEFAULT_READY_TIMEOUT_MS
    grace_period_ms: int = DEFAULT_GRACE_PERIOD_MS
    confirm_timeout_ms: int = DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS
    shutdown_confirm_timeout_ms: int = DEFAULT_SHUTDOWN_CONFIRM_TIMEOUT_MS


@dataclass(frozen=True, slots=True)
class CancelOutcome:
    """The observable result of one cancellation command."""

    task_id: TaskId
    state: LifecycleState
    active_cancellation: bool


@dataclass(frozen=True, slots=True)
class ActiveTaskNotRunningError(ValueError):
    """An active cancellation was requested for a task with no live worker."""

    task_id: TaskId

    @override
    def __str__(self) -> str:
        return f"task {self.task_id} has no running worker to cancel"


@dataclass(frozen=True, slots=True)
class TaskNotCancellableError(ValueError):
    """Cancellation was requested for a task in a non-cancellable state."""

    task_id: TaskId
    state: LifecycleState

    @override
    def __str__(self) -> str:
        return f"task {self.task_id} in state {self.state.value} cannot be cancelled"


@dataclass(frozen=True, slots=True)
class RuntimeShutdownStartedError(ValueError):
    """The runtime may begin its bounded shutdown exactly once."""

    @override
    def __str__(self) -> str:
        return "the runtime shutdown already started"
