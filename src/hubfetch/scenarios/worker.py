"""Headless scenario worker entry point over the exhaustive dispatcher.

The scenario runner and the end-to-end tests launch real contained workers
through this module instead of the Todo 14 stub entry point, so the envelope
release is followed by the actual Hub/Git transfer handlers selected
exhaustively by :func:`hubfetch.worker.dispatch.dispatch_command`. The boot
contract is identical to the product worker: bounded argv, one
``worker_ready`` event, then a block on stdin until the envelope arrives. No
Hub, Git, or filesystem destination work happens before that envelope.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, BinaryIO, Final

from hubfetch.credentials.models import InvalidCredentialAliasError
from hubfetch.credentials.port import (
    CredentialBackendError,
    CredentialBackendRejectedError,
)
from hubfetch.domain.ipc import WorkerReadyEvent
from hubfetch.runtime.worker_command import WorkerArgvError, parse_worker_argv
from hubfetch.worker.dispatch import (
    config_from_worker_environment,
    dispatch_command,
)
from hubfetch.worker.handshake import (
    WorkerEventWriter,
    WorkerHandshakeError,
    read_envelope,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

_BOOT_FAILURE: Final = "scenario worker boot failure"


def main(argv: Sequence[str] | None = None) -> int:
    """Run the contained scenario worker boot and dispatch one envelope."""
    raw = tuple(sys.argv[1:] if argv is None else argv)
    try:
        _ = parse_worker_argv(raw)
    except WorkerArgvError as error:
        _ = sys.stderr.write(f"{error}\n")
        return 2
    try:
        config = config_from_worker_environment(command_stream=_stdin())
        writer = WorkerEventWriter(_stdout())
        writer.emit(WorkerReadyEvent())
        frames = read_envelope(_stdin())
    except (
        WorkerHandshakeError,
        InvalidCredentialAliasError,
        CredentialBackendError,
        CredentialBackendRejectedError,
    ) as error:
        _ = sys.stderr.write(f"{_BOOT_FAILURE}: {error}\n")
        return 1
    for frame in frames:
        exit_code = dispatch_command(frame.command, writer, config=config)
        if exit_code != 0:
            return exit_code
    return 0


def _stdout() -> BinaryIO:
    """Return the worker's binary stdout, failing when the pipe is absent."""
    stream = sys.stdout
    if stream is None:
        raise WorkerHandshakeError(
            code="stdio_unavailable", detail="the worker stdout pipe is missing"
        )
    return stream.buffer


def _stdin() -> BinaryIO:
    """Return the worker's binary stdin, failing when the pipe is absent."""
    stream = sys.stdin
    if stream is None:
        raise WorkerHandshakeError(
            code="stdio_unavailable", detail="the worker stdin pipe is missing"
        )
    return stream.buffer


if __name__ == "__main__":
    sys.exit(main())
