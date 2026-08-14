"""Worker Git clone handler: typed transport events for one contained clone.

The handler consumes a ``start_task`` envelope whose spec is a ``git_clone``,
derives the HTTPS URL through :func:`hubfetch.git.clone_url.https_clone_url`,
runs the contained :class:`GitCloner` with cooperative cancellation, and emits
``stage_changed`` and ``progress`` events through the Todo 14 worker writer
before exactly one terminal event. Git's object counts are reported in the
transport's byte progress fields because that monotonic done/total pair is the
only progress measure the Todo 14 event model exposes; the phase transitions
are reported through ``stage_changed``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

from hubfetch.domain.errors import CancellationError, HubFetchError
from hubfetch.domain.ipc import (
    CancelledEvent,
    FailedEvent,
    ProgressEvent,
    StageChangedEvent,
    StartTaskCommand,
    SucceededEvent,
)
from hubfetch.domain.lifecycle import TransferStage
from hubfetch.domain.task_spec import (
    GitCloneSpec,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.git.clone_command import CloneOptions
from hubfetch.git.clone_url import https_clone_url
from hubfetch.git.cloner import GitCloner
from hubfetch.git.progress import GitProgressRecord, ProgressPhase

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from hubfetch.worker.handshake import WorkerEventWriter


@final
class GitCloneHandler:
    """Handle one ``git_clone`` task through the Todo 14 worker writer."""

    __slots__: Final = ("_cancel", "_environment", "_git_command")

    def __init__(
        self,
        *,
        git_command: tuple[str, ...] = ("git",),
        environment: Mapping[str, str] | None = None,
        cancel: Callable[[], bool] | None = None,
    ) -> None:
        """Own the clone configuration and the cooperative cancel callback."""
        self._git_command = git_command
        self._environment = dict(environment) if environment is not None else None
        self._cancel = cancel

    def handle(self, command: StartTaskCommand, writer: WorkerEventWriter) -> int:
        """Dispatch one start_task envelope and emit transport events."""
        match command.spec:
            case GitCloneSpec() as spec:
                return self._clone(spec, command, writer)
            case SingleFileDownloadSpec() | SnapshotDownloadSpec():
                writer.emit(
                    FailedEvent(
                        task_id=command.task_id,
                        attempt_id=command.attempt_id,
                        error_code="internal",
                    )
                )
                return 1

    def _clone(
        self, spec: GitCloneSpec, command: StartTaskCommand, writer: WorkerEventWriter
    ) -> int:
        """Run one clone, streaming progress, and emit the terminal event."""
        cloner = GitCloner(git_command=self._git_command, environment=self._environment)
        options = CloneOptions(revision=spec.repository.revision)
        writer.emit(
            StageChangedEvent(
                task_id=command.task_id,
                attempt_id=command.attempt_id,
                stage=TransferStage.PREFLIGHT,
            )
        )
        materialize_emitted = False

        def on_progress(record: GitProgressRecord) -> None:
            nonlocal materialize_emitted
            if record.phase is ProgressPhase.UPDATING and not materialize_emitted:
                materialize_emitted = True
                writer.emit(
                    StageChangedEvent(
                        task_id=command.task_id,
                        attempt_id=command.attempt_id,
                        stage=TransferStage.MATERIALIZE,
                    )
                )
            writer.emit(
                ProgressEvent(
                    task_id=command.task_id,
                    attempt_id=command.attempt_id,
                    bytes_done=record.done,
                    bytes_total=record.total,
                )
            )

        writer.emit(
            StageChangedEvent(
                task_id=command.task_id,
                attempt_id=command.attempt_id,
                stage=TransferStage.TRANSFER,
            )
        )
        try:
            _ = cloner.clone(
                https_clone_url(spec.repository).value,
                spec.destination,
                options,
                cancel=self._cancel,
                on_progress=on_progress,
            )
        except CancellationError:
            writer.emit(
                CancelledEvent(task_id=command.task_id, attempt_id=command.attempt_id)
            )
            return 0
        except HubFetchError as error:
            writer.emit(
                FailedEvent(
                    task_id=command.task_id,
                    attempt_id=command.attempt_id,
                    error_code=error.spec.category.value,
                )
            )
            return 1
        writer.emit(
            SucceededEvent(task_id=command.task_id, attempt_id=command.attempt_id)
        )
        return 0
