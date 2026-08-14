"""Worker entry point: contained boot, bounded envelope, stub task dispatch.

The worker's pre-envelope behavior is strictly bounded: parse the minimal
argv shape, emit exactly one ``worker_ready`` event, and block on stdin for
the task envelope. No Hub, Git, or filesystem destination work happens before
that envelope arrives; the GUI withholds it until Job assignment succeeds.
After the envelope, a stub dispatcher proves the release by creating the
destination directory and reports a typed terminal failure until the real
transfer handlers ship in later todos.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, BinaryIO

from hubfetch.domain.ipc import (
    CancelTaskCommand,
    FailedEvent,
    GuiCommand,
    ShutdownCommand,
    StartTaskCommand,
    WorkerReadyEvent,
)
from hubfetch.domain.task_spec import (
    GitCloneSpec,
    LocalDirectoryDestination,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.runtime.worker_command import WorkerArgvError, parse_worker_argv
from hubfetch.worker.handshake import (
    WorkerEventWriter,
    WorkerHandshakeError,
    read_envelope,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

TRANSFER_HANDLER_UNAVAILABLE: str = "transfer_handler_unavailable"
"""Typed failure code reported by the pre-handler stub dispatch."""


def _stdout_buffer() -> BinaryIO:
    """Return the worker's binary stdout, failing when the pipe is absent."""
    stream = sys.stdout
    if stream is None:
        raise WorkerHandshakeError(
            code="stdio_unavailable", detail="the worker stdout pipe is missing"
        )
    return stream.buffer


def _stdin_buffer() -> BinaryIO:
    """Return the worker's binary stdin, failing when the pipe is absent."""
    stream = sys.stdin
    if stream is None:
        raise WorkerHandshakeError(
            code="stdio_unavailable", detail="the worker stdin pipe is missing"
        )
    return stream.buffer


def main(argv: Sequence[str] | None = None) -> int:
    """Run the contained worker boot and dispatch one task envelope."""
    raw = tuple(sys.argv[1:] if argv is None else argv)
    try:
        _ = parse_worker_argv(raw)
    except WorkerArgvError as error:
        _ = sys.stderr.write(f"{error}\n")
        return 2
    try:
        writer = WorkerEventWriter(_stdout_buffer())
        writer.emit(WorkerReadyEvent())
        frames = read_envelope(_stdin_buffer())
    except WorkerHandshakeError as error:
        _ = sys.stderr.write(f"{error}\n")
        return 1
    for frame in frames:
        exit_code = _dispatch(frame.command, writer)
        if exit_code != 0:
            return exit_code
    return 0


def _dispatch(command: GuiCommand, writer: WorkerEventWriter) -> int:
    """Dispatch one decoded command to the matching handler."""
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
            return _run_start_task(start, writer)


def _run_start_task(command: StartTaskCommand, writer: WorkerEventWriter) -> int:
    """Stub dispatch: prove post-release capability, then fail typed.

    This stub creates the destination directory as the observable
    post-release side effect (it is withheld entirely until the envelope
    arrives) and then emits one typed terminal failure so the attempt never
    claims a success the worker did not perform. Real transfer handlers ship
    in later todos and replace this dispatch.
    """
    _probe_destination(command)
    writer.emit(
        FailedEvent(
            task_id=command.task_id,
            attempt_id=command.attempt_id,
            error_code=TRANSFER_HANDLER_UNAVAILABLE,
        )
    )
    return 1


def _probe_destination(command: StartTaskCommand) -> None:
    """Create the task destination directory as the release-observable probe."""
    match command.spec:
        case SingleFileDownloadSpec() | SnapshotDownloadSpec() as spec:
            if isinstance(spec.destination, LocalDirectoryDestination):
                spec.destination.path.mkdir(parents=True, exist_ok=True)
        case GitCloneSpec() as spec:
            spec.destination.mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    sys.exit(main())
