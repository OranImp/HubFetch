"""Worker-side handshake: one ``worker_ready`` event, then a bounded envelope read.

The handshake is the worker's entire pre-envelope contract. After process
initialization the worker emits exactly one sequenced ``worker_ready`` event
and then blocks on stdin until a complete command frame arrives or the stream
closes. Before that frame is delivered the worker must not perform any Hub,
Git, or filesystem destination work; the GUI withholds the envelope until its
Job assignment succeeds, so the frame itself is the release.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, BinaryIO, Final, final, override

from hubfetch.runtime.jsonl_transport import (
    MAX_LINE_BYTES,
    MAX_TOTAL_BYTES,
    CommandFrame,
    JsonlCommandReader,
    TransportProtocolError,
    encode_event_frame,
)

if TYPE_CHECKING:
    from hubfetch.domain.ipc import WorkerEvent


@dataclass(frozen=True, slots=True)
class WorkerHandshakeError(ValueError):
    """The worker could not complete the bounded boot handshake."""

    code: str
    detail: str

    @override
    def __str__(self) -> str:
        return f"worker handshake failure {self.code}: {self.detail}"


@final
class WorkerEventWriter:
    """Sequenced JSONL writer for the worker's event channel."""

    __slots__: Final = ("_sequence", "_stream")

    def __init__(self, stream: BinaryIO) -> None:
        """Own the binary stream and start the event sequence at zero."""
        self._stream = stream
        self._sequence = 0

    def emit(self, event: WorkerEvent) -> None:
        """Write one worker event with the next sequence identifier."""
        _ = self._stream.write(encode_event_frame(event, self._sequence))
        self._sequence += 1
        self._stream.flush()


def read_envelope(
    stream: BinaryIO,
    *,
    max_line_bytes: int = MAX_LINE_BYTES,
    max_total_bytes: int = MAX_TOTAL_BYTES,
) -> tuple[CommandFrame, ...]:
    """Block on ``stream`` for the task envelope, bounded by EOF and size limits.

    Returns every complete command frame decoded from the stream. The block
    ends when a frame arrives, when the stream reaches EOF, or when a framing
    or sequence violation raises :class:`WorkerHandshakeError`. The GUI's
    bounded Job termination closes the pipe, so EOF is the worker's hard bound.
    """
    reader = JsonlCommandReader(
        max_line_bytes=max_line_bytes, max_total_bytes=max_total_bytes
    )
    while True:
        chunk = stream.readline(max_line_bytes + 1)
        if not chunk:
            if reader.has_pending_input:
                raise WorkerHandshakeError(
                    code="eof_incomplete_frame",
                    detail="stdin closed before a complete command frame arrived",
                )
            raise WorkerHandshakeError(
                code="eof_before_envelope",
                detail="stdin closed before the task envelope arrived",
            )
        try:
            frames = reader.feed(chunk)
        except TransportProtocolError as error:
            raise WorkerHandshakeError(code=error.code, detail=error.detail) from error
        if frames:
            return frames
