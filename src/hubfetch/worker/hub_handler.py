"""Worker Hub download handler: typed transport events for one contained download.

The handler consumes a ``start_task`` envelope whose spec is a single-file or
snapshot download, drives the pinned library through :class:`HubDownloader` with
cooperative cancellation, and emits ``stage_changed`` and bounded-rate
``progress`` events through the Todo 14 worker writer before exactly one
terminal event. The terminal ``succeeded`` event is emitted only after every
path the library returned exists on disk and the ``finalize`` stage completes.
Cooperative cancellation comes from an injected probe (tests) or a
:class:`WorkerControlReader` that watches the worker stdin for a ``cancel_task``
command; Todo 16 remains the bounded hard-stop for stalled calls.
"""

from __future__ import annotations

import json
import threading
from typing import TYPE_CHECKING, BinaryIO, final

from hubfetch.domain.errors import (
    CancellationError,
    ErrorCategory,
    HubFetchError,
    error_for,
)
from hubfetch.domain.ipc import (
    CancelledEvent,
    CancelTaskCommand,
    FailedEvent,
    IpcDecodeError,
    ProgressEvent,
    ShutdownCommand,
    StageChangedEvent,
    StartTaskCommand,
    SucceededEvent,
    decode_wire,
)
from hubfetch.domain.lifecycle import TransferStage
from hubfetch.domain.task_spec import (
    GitCloneSpec,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.hub.downloader import DownloadResult, HubDownloader
from hubfetch.hub.progress import ProgressSink, ProgressUpdate
from hubfetch.runtime.jsonl_framing import (
    MAX_LINE_BYTES,
    TransportProtocolError,
    parse_frame,
    validate_sequence,
)
from hubfetch.security.redaction import Redactor

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore
    from hubfetch.worker.handshake import WorkerEventWriter

__all__ = ["HubDownloadHandler", "WorkerControlReader"]


@final
class WorkerControlReader:
    """Watch a worker stdin stream and set a process-local event on cancel.

    The task envelope occupies command sequence 0, so this reader starts at
    sequence 1 and strictly validates every later frame. A daemon thread blocks
    on ``readline`` until a frame arrives, EOF closes the pipe (the GUI's Job
    teardown), or a protocol failure ends the reader conservatively.
    """

    def __init__(
        self,
        stream: BinaryIO,
        *,
        start_sequence: int = 1,
    ) -> None:
        """Own the stdin stream and start the daemon control-reader thread."""
        self._stream = stream
        self._expected = start_sequence
        self._cancelled = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def is_cancelled(self) -> bool:
        """Return whether a ``cancel_task`` command was observed."""
        return self._cancelled.is_set()

    def _run(self) -> None:
        """Read command frames until cancel, shutdown, EOF, or a protocol error."""
        while True:
            line = self._stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                return
            try:
                sequence, payload = parse_frame(line, "command")
                sequence, self._expected = validate_sequence(sequence, self._expected)
                message = decode_wire(json.dumps(payload))
            except (TransportProtocolError, IpcDecodeError):
                return  # a broken control channel stops the reader conservatively
            match message:
                case CancelTaskCommand():
                    self._cancelled.set()
                    return
                case ShutdownCommand():
                    return
                case _:
                    continue


@final
class HubDownloadHandler:
    """Handle one download task through the Todo 14 worker writer.

    ``cancel`` is an injected cooperative probe; when ``command_stream`` is given
    instead, a :class:`WorkerControlReader` supplies the probe from a
    ``cancel_task`` command. ``endpoint``/``etag_timeout``/``cache_dir`` mirror
    the downloader seams; ``credential_alias``/``credential_store`` resolve a
    manual-token alias inside the worker (Todo 8). ``progress_interval_seconds``
    bounds the non-final progress events emitted to the wire.
    """

    def __init__(  # noqa: PLR0913 - config bundle mirroring the downloader seams
        self,
        *,
        endpoint: str | None = None,
        etag_timeout: float | None = None,
        cache_dir: Path | None = None,
        credential_alias: CredentialAlias | None = None,
        credential_store: CredentialStore | None = None,
        cancel: Callable[[], bool] | None = None,
        command_stream: BinaryIO | None = None,
        progress_interval_seconds: float = 0.1,
    ) -> None:
        """Bind the downloader config, cancellation seams, and progress rate."""
        self._endpoint = endpoint
        self._etag_timeout = etag_timeout
        self._cache_dir = cache_dir
        self._credential_alias = credential_alias
        self._credential_store = credential_store
        self._cancel = cancel
        self._command_stream = command_stream
        self._progress_interval_seconds = progress_interval_seconds
        self._redactor = Redactor()

    def handle(self, command: StartTaskCommand, writer: WorkerEventWriter) -> int:
        """Dispatch one start_task envelope and emit exactly one terminal event."""
        match command.spec:
            case SingleFileDownloadSpec() | SnapshotDownloadSpec() as spec:
                return self._download(spec, command, writer)
            case GitCloneSpec():
                writer.emit(
                    FailedEvent(
                        task_id=command.task_id,
                        attempt_id=command.attempt_id,
                        error_code="internal",
                    )
                )
                return 1

    def _download(
        self,
        spec: SingleFileDownloadSpec | SnapshotDownloadSpec,
        command: StartTaskCommand,
        writer: WorkerEventWriter,
    ) -> int:
        """Run one download, stream progress, and emit the terminal event."""
        cancel = self._cancel or (
            WorkerControlReader(self._command_stream, start_sequence=1).is_cancelled
            if self._command_stream is not None
            else None
        )
        try:
            downloader = HubDownloader(
                auth_source=spec.auth_source,
                proxy_mode=spec.proxy_mode,
                credential_alias=self._credential_alias,
                credential_store=self._credential_store,
                endpoint=self._endpoint,
                etag_timeout=self._etag_timeout,
                cache_dir=self._cache_dir,
            )
            emit = self._emit_fn(command, writer)
            sink = ProgressSink(
                emit=emit,
                interval_seconds=self._progress_interval_seconds,
                redactor=self._redactor,
                cancel=cancel,
            )
            self._emit_stage(writer, command, sink, TransferStage.PREFLIGHT)
            sink.checkpoint()
            self._emit_stage(writer, command, sink, TransferStage.TRANSFER)
            result = downloader.download(spec, progress=sink)
            sink.checkpoint()
            self._verify_paths(result)
            self._emit_stage(writer, command, sink, TransferStage.MATERIALIZE)
            sink.checkpoint()
            sink.complete()
            self._emit_stage(writer, command, sink, TransferStage.FINALIZE)
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
        else:
            # Exactly one terminal result, emitted only after every returned
            # path exists and the finalize stage completed above.
            writer.emit(
                SucceededEvent(task_id=command.task_id, attempt_id=command.attempt_id)
            )
            return 0

    def _emit_stage(
        self,
        writer: WorkerEventWriter,
        command: StartTaskCommand,
        sink: ProgressSink,
        stage: TransferStage,
    ) -> None:
        """Emit one stage-changed event and begin the matching sink phase."""
        writer.emit(
            StageChangedEvent(
                task_id=command.task_id,
                attempt_id=command.attempt_id,
                stage=stage,
            )
        )
        sink.begin(stage)

    def _emit_fn(
        self, command: StartTaskCommand, writer: WorkerEventWriter
    ) -> Callable[[ProgressUpdate], None]:
        """Return the sink emit bridge translating samples into wire progress."""

        def emit(update: ProgressUpdate) -> None:
            total = update.bytes_total if update.bytes_total is not None else 0
            writer.emit(
                ProgressEvent(
                    task_id=command.task_id,
                    attempt_id=command.attempt_id,
                    bytes_done=update.bytes_done,
                    bytes_total=total,
                )
            )

        return emit

    def _verify_paths(self, result: DownloadResult) -> None:
        """Finalization gate: every returned path must exist on disk."""
        for path in result.paths:
            if not path.exists():
                raise error_for(
                    ErrorCategory.INTERNAL,
                    detail="a returned download path does not exist",
                )
