"""Typed composition root for the HubFetch desktop runtime.

Bootstrap owns the ordered wiring of Todo 21's runtime: configuration and
path creation, transactional persistence with one idempotent startup recovery,
the single-owner lock, the GUI-free FIFO scheduler inside the
:class:`Runtime` facade, read-only diagnostics gates, fail-closed credential
verification, and finally the dispatch gate. Startup is never silently
partial: every failure is returned as a typed :class:`FatalStartupError`, and
recoverable concerns (Git/Xet readiness, writable cache, keyring backend) are
reported as typed :class:`DegradedDiagnostic` values so the caller can show
them without treating them as fatal.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, assert_never, final, override

from hubfetch.application.runtime import Runtime, RuntimeConfig, WorkerEnvOverrides
from hubfetch.application.runtime_contracts import (
    DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS,
    DEFAULT_GRACE_PERIOD_MS,
    DEFAULT_SHUTDOWN_CONFIRM_TIMEOUT_MS,
)
from hubfetch.config.bootstrap import (
    AppPathsResult,
    ConfigurationError,
    bootstrap_configuration,
)
from hubfetch.config.identity import APP_IDENTITY, AppIdentity
from hubfetch.credentials.port import CredentialBackendRejectedError
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.diagnostics.filesystem import probe_directory
from hubfetch.diagnostics.git import (
    DependencyState,
    GitDependencyChecker,
    GitDependencyReport,
)
from hubfetch.persistence.connection import (
    ConnectionOpenError,
    open_connection,
)
from hubfetch.persistence.migrations import (
    UnsupportedSchemaVersionError,
    migrate,
)
from hubfetch.persistence.settings_repository import SettingsRepository
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.runtime_owner import (
    FileLockRuntimeOwner,
    RuntimeOwnerUnavailableError,
)
from hubfetch.runtime.worker_command import build_worker_argv
from hubfetch.runtime.worker_process_types import DEFAULT_READY_TIMEOUT_MS

if TYPE_CHECKING:
    from collections.abc import Mapping
    from pathlib import Path

    from hubfetch.config.settings import SettingsPayload
    from hubfetch.domain.ids import TaskId

__all__ = [
    "BootstrapOptions",
    "DegradedDiagnostic",
    "FatalStartupError",
    "StartupOutcome",
    "WorkerEnvOverrides",
    "bootstrap_runtime",
]


@dataclass(frozen=True, slots=True)
class FatalStartupError(ValueError):
    """The runtime cannot start at all; nothing was partially composed."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"fatal startup failure: {self.reason}"


@dataclass(frozen=True, slots=True)
class DegradedDiagnostic:
    """One recoverable startup concern that does not block dispatch."""

    code: str
    detail: str


@dataclass(frozen=True, slots=True)
class StartupOutcome:
    """The typed result of one bootstrap attempt: runtime or fatal error."""

    runtime: Runtime | None
    fatal: FatalStartupError | None
    degraded: tuple[DegradedDiagnostic, ...]
    recovered: tuple[TaskId, ...]
    git_report: GitDependencyReport | None
    paths: AppPathsResult | None


@dataclass(frozen=True, slots=True)
class BootstrapOptions:
    """Typed bootstrap inputs; defaults compose the product development mode."""

    identity: AppIdentity = APP_IDENTITY
    settings_payload: SettingsPayload | None = None
    worker_command_prefix: tuple[str, ...] | None = None
    worker_overrides: WorkerEnvOverrides = field(default_factory=WorkerEnvOverrides)
    open_dispatch_gate: bool = True
    ready_timeout_ms: int = DEFAULT_READY_TIMEOUT_MS
    grace_period_ms: int = DEFAULT_GRACE_PERIOD_MS
    confirm_timeout_ms: int = DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS
    shutdown_confirm_timeout_ms: int = DEFAULT_SHUTDOWN_CONFIRM_TIMEOUT_MS
    parent_environment: Mapping[str, str] | None = None


@final
class SystemClock:
    """Wall-clock implementation of the persistence clock protocol."""

    def now(self) -> datetime:
        """Return the current aware UTC instant."""
        return datetime.now(UTC)


def bootstrap_runtime(*, options: BootstrapOptions | None = None) -> StartupOutcome:
    """Compose one runtime under the application paths or fail with a typed error.

    Wiring order: settings/persistence, one idempotent startup recovery through
    ``Runtime.start``, read-only diagnostics gates, fail-closed credential
    verification, and the dispatch gate. Every recoverable concern is collected
    into ``degraded``; every blocking concern returns ``runtime=None`` with a
    typed fatal error so no silent partial startup is possible.
    """
    opts = options if options is not None else BootstrapOptions()
    try:
        configuration = bootstrap_configuration(opts.settings_payload, opts.identity)
    except ConfigurationError as error:
        return StartupOutcome(
            runtime=None,
            fatal=FatalStartupError(reason=str(error)),
            degraded=(),
            recovered=(),
            git_report=None,
            paths=None,
        )
    paths = configuration.paths
    clock = SystemClock()
    connection: sqlite3.Connection | None = None
    try:
        connection = open_connection(paths.database_path)
        migrate(connection)
    except (ConnectionOpenError, UnsupportedSchemaVersionError, sqlite3.Error) as error:
        if connection is not None:
            connection.close()
        return StartupOutcome(
            runtime=None,
            fatal=FatalStartupError(reason=f"persistence unavailable: {error}"),
            degraded=(),
            recovered=(),
            git_report=None,
            paths=paths,
        )
    try:
        settings_repository = SettingsRepository(connection, clock=clock)
        persisted = settings_repository.load()
        if persisted is None:
            settings_repository.save(configuration.settings)
        settings = persisted if persisted is not None else configuration.settings
        owner = FileLockRuntimeOwner(_lock_path(paths.database_path))
        repository = TaskRepository(connection, clock=clock)
        runtime = Runtime(
            config=RuntimeConfig(
                repository=repository,
                owner=owner,
                connection=connection,
                settings=settings,
                parent_environment=(
                    opts.parent_environment
                    if opts.parent_environment is not None
                    else dict(os.environ)
                ),
                worker_command_prefix=(
                    opts.worker_command_prefix
                    if opts.worker_command_prefix is not None
                    else _default_worker_prefix()
                ),
                worker_overrides=opts.worker_overrides,
                ready_timeout_ms=opts.ready_timeout_ms,
                grace_period_ms=opts.grace_period_ms,
                confirm_timeout_ms=opts.confirm_timeout_ms,
                shutdown_confirm_timeout_ms=opts.shutdown_confirm_timeout_ms,
            )
        )
        report = runtime.start()
    except RuntimeOwnerUnavailableError as error:
        connection.close()
        return StartupOutcome(
            runtime=None,
            fatal=FatalStartupError(reason=str(error)),
            degraded=(),
            recovered=(),
            git_report=None,
            paths=paths,
        )
    degraded: list[DegradedDiagnostic] = []
    git_report = GitDependencyChecker().check()
    degraded.extend(_git_degraded(git_report))
    cache_probe = probe_directory(paths.cache_root)
    if not cache_probe.writable:
        degraded.append(
            DegradedDiagnostic(
                code="cache_not_writable",
                detail=cache_probe.error or "the cache root is not writable",
            )
        )
    try:
        _ = WindowsCredentialManagerStore()
    except CredentialBackendRejectedError as error:
        degraded.append(DegradedDiagnostic(code="keyring_rejected", detail=str(error)))
    if opts.open_dispatch_gate:
        runtime.mark_diagnostics_ready()
    return StartupOutcome(
        runtime=runtime,
        fatal=None,
        degraded=tuple(degraded),
        recovered=report.recovered,
        git_report=git_report,
        paths=paths,
    )


def _lock_path(database_path: Path) -> Path:
    """Return the runtime-owner lock path beside the database."""
    return database_path.with_name(f"{database_path.name}.lock")


def _default_worker_prefix() -> tuple[str, ...]:
    """Return the development worker argv without the session locator tail."""
    argv = build_worker_argv(session_locator="placeholder", frozen=False)
    return tuple(argv[:-1])


def _git_degraded(report: GitDependencyReport) -> tuple[DegradedDiagnostic, ...]:
    """Map the read-only Git dependency report to non-fatal diagnostics."""
    match report.state:
        case DependencyState.READY:
            return ()
        case DependencyState.DEGRADED:
            return (
                DegradedDiagnostic(
                    code="xet_degraded",
                    detail="Git-Xet is missing or its filters are not configured",
                ),
            )
        case DependencyState.BLOCKED:
            return (
                DegradedDiagnostic(
                    code="git_unavailable",
                    detail="system Git is not usable; clone tasks will fail",
                ),
            )
        case _:
            assert_never(report.state)
