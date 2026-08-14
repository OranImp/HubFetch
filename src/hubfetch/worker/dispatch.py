"""Exhaustive worker handler selection by task specification tag.

The dispatcher is the single seam between a decoded ``start_task`` envelope and
the transfer handlers from Todos 18/19. Selection is exhaustive: every closed
``TaskSpec`` kind routes to exactly one handler (``single_file``/``snapshot``
to :class:`HubDownloadHandler`, ``git_clone`` to :class:`GitCloneHandler`), and
a new task kind is a compile-time error here instead of a silent fallthrough.
A shared :class:`WorkerControlReader` supplies cooperative cancellation to both
handlers from the worker's stdin, so one bounded control channel covers every
transfer kind.

This module is GUI-free and owns no process state; the worker entry point
builds :class:`WorkerHandlerConfig` from the documented non-secret environment
seams and calls :func:`dispatch_command`.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, Final, assert_never

from hubfetch.credentials.models import parse_credential_alias
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.domain.ipc import (
    CancelTaskCommand,
    FailedEvent,
    GuiCommand,
    ShutdownCommand,
    StartTaskCommand,
)
from hubfetch.domain.task_spec import (
    GitCloneSpec,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.worker.git_handler import GitCloneHandler
from hubfetch.worker.hub_handler import HubDownloadHandler, WorkerControlReader

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore
    from hubfetch.worker.handshake import WorkerEventWriter

__all__ = ["WorkerHandlerConfig", "config_from_worker_environment", "dispatch_command"]

HUB_ENDPOINT_ENV: Final = "HUBFETCH_HUB_ENDPOINT"
"""Documented test/portable seam: fixture endpoint injected into the worker."""
HUB_CACHE_ENV: Final = "HUBFETCH_HUB_CACHE"
"""Documented test/portable seam: isolated Hub cache root in the worker."""
CREDENTIAL_ALIAS_ENV: Final = "HUBFETCH_CREDENTIAL_ALIAS"
"""Non-secret opaque alias the worker resolves through the credential store."""


@dataclass(frozen=True, slots=True)
class WorkerHandlerConfig:
    """Configuration bundle handed to the transfer handlers by the dispatcher.

    Built inside the worker process from the documented environment seams (or
    injected directly in tests). The config never carries token bytes: only the
    opaque credential alias crosses into the worker, and the store resolves it
    locally inside the contained process.
    """

    hub_endpoint: str | None = None
    hub_etag_timeout: float | None = None
    hub_cache_dir: Path | None = None
    credential_alias: CredentialAlias | None = None
    credential_store: CredentialStore | None = None
    git_command: tuple[str, ...] = ("git",)
    git_environment: Mapping[str, str] | None = None
    progress_interval_seconds: float = 0.1
    command_stream: BinaryIO | None = None
    cancel: Callable[[], bool] | None = None


def config_from_worker_environment(
    *, command_stream: BinaryIO | None = None
) -> WorkerHandlerConfig:
    """Build a handler config from the documented worker environment seams.

    The alias is parsed through the opaque boundary contract and the credential
    store is constructed (fail-closed) only when an alias is present, so an
    anonymous worker never touches the vault.
    """
    alias_raw = os.environ.get(CREDENTIAL_ALIAS_ENV)
    alias = parse_credential_alias(alias_raw) if alias_raw else None
    cache_raw = os.environ.get(HUB_CACHE_ENV)
    return WorkerHandlerConfig(
        hub_endpoint=os.environ.get(HUB_ENDPOINT_ENV),
        hub_cache_dir=Path(cache_raw) if cache_raw else None,
        credential_alias=alias,
        credential_store=WindowsCredentialManagerStore() if alias is not None else None,
        command_stream=command_stream,
    )


def dispatch_command(
    command: GuiCommand,
    writer: WorkerEventWriter,
    *,
    config: WorkerHandlerConfig,
) -> int:
    """Dispatch one decoded GUI command to the matching worker handler.

    ``start_task`` routes to the task-kind dispatch; ``shutdown`` is a clean
    exit; a stray ``cancel_task`` with no active task is a typed failure so the
    worker never claims a success it did not perform. The match is exhaustive:
    a new ``GuiCommand`` variant fails the type checker instead of falling
    through silently.
    """
    match command:
        case ShutdownCommand():
            return 0
        case CancelTaskCommand() as cancel:
            writer.emit(
                FailedEvent(
                    task_id=cancel.task_id,
                    attempt_id=cancel.attempt_id,
                    error_code="no_active_task",
                )
            )
            return 1
        case StartTaskCommand() as start:
            return _dispatch_start(start, writer, config=config)
        case _:
            assert_never(command)


def _dispatch_start(
    command: StartTaskCommand,
    writer: WorkerEventWriter,
    *,
    config: WorkerHandlerConfig,
) -> int:
    """Route one task envelope to its handler by an exhaustive spec-kind match.

    A shared control reader on the worker stdin supplies cooperative
    cancellation to whichever handler the spec selects; the reader is started
    exactly once per task.
    """
    cancel = config.cancel
    if cancel is None and config.command_stream is not None:
        reader = WorkerControlReader(config.command_stream, start_sequence=1)
        cancel = reader.is_cancelled
    match command.spec:
        case SingleFileDownloadSpec() | SnapshotDownloadSpec():
            handler = HubDownloadHandler(
                endpoint=config.hub_endpoint,
                etag_timeout=config.hub_etag_timeout,
                cache_dir=config.hub_cache_dir,
                credential_alias=config.credential_alias,
                credential_store=config.credential_store,
                cancel=cancel,
                progress_interval_seconds=config.progress_interval_seconds,
            )
            return handler.handle(command, writer)
        case GitCloneSpec():
            handler = GitCloneHandler(
                git_command=config.git_command,
                environment=config.git_environment,
                cancel=cancel,
            )
            return handler.handle(command, writer)
        case _:
            assert_never(command.spec)
