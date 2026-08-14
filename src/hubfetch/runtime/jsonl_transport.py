"""Incremental UTF-8 JSONL stream readers with typed sequence enforcement.

The readers consume worker stdout (events) and GUI stdin (commands) byte by
byte, enforce the strictly increasing sequence contract from zero on each
channel, and fail closed with typed :class:`TransportProtocolError` codes.
Frame encoding and one-line parsing primitives live in
:mod:`hubfetch.runtime.jsonl_framing`; this module owns the incremental
buffering and the per-channel message gates.
"""

from __future__ import annotations

import json
from typing import Final, final

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
    WorkerReadyEvent,
    decode_wire,
)
from hubfetch.runtime.jsonl_framing import (
    MAX_LINE_BYTES,
    MAX_TOTAL_BYTES,
    CommandFrame,
    EventFrame,
    FrameValue,
    TransportProtocolError,
    encode_command_frame,
    encode_event_frame,
    parse_frame,
    validate_sequence,
)

__all__ = (
    "MAX_LINE_BYTES",
    "MAX_TOTAL_BYTES",
    "CommandFrame",
    "EventFrame",
    "JsonlCommandReader",
    "JsonlEventReader",
    "TransportProtocolError",
    "encode_command_frame",
    "encode_event_frame",
)

_WORKER_EVENT_KINDS: Final = frozenset(
    {
        "worker_ready",
        "stage_changed",
        "progress",
        "succeeded",
        "failed",
        "cancelled",
    }
)
_COMMAND_KINDS: Final = frozenset({"start_task", "cancel_task", "shutdown"})


@final
class _Framing:
    """Shared incremental framing state: buffering, sizes, and sequencing."""

    __slots__: Final = (
        "_buffer",
        "_expected_sequence",
        "_max_line_bytes",
        "_max_total_bytes",
        "_payload_key",
        "_total_bytes",
    )

    def __init__(
        self,
        *,
        payload_key: str,
        max_line_bytes: int,
        max_total_bytes: int,
    ) -> None:
        self._buffer = b""
        self._total_bytes = 0
        self._expected_sequence = 0
        self._max_line_bytes = max_line_bytes
        self._max_total_bytes = max_total_bytes
        self._payload_key = payload_key

    def consume(self, chunk: bytes) -> tuple[tuple[int, FrameValue], ...]:
        """Consume a chunk and return every finished ``(sequence, payload)`` pair."""
        self._buffer += chunk
        self._total_bytes += len(chunk)
        if self._total_bytes > self._max_total_bytes:
            raise TransportProtocolError(
                code="oversized_total",
                detail=f"cumulative input exceeded {self._max_total_bytes} bytes",
            )
        frames: list[tuple[int, FrameValue]] = []
        while (newline := self._buffer.find(b"\n")) != -1:
            line = self._buffer[:newline]
            self._buffer = self._buffer[newline + 1 :]
            if len(line) > self._max_line_bytes:
                raise TransportProtocolError(
                    code="oversized_line",
                    detail=f"a line exceeded {self._max_line_bytes} bytes",
                )
            sequence_raw, payload = parse_frame(line, self._payload_key)
            sequence, self._expected_sequence = validate_sequence(
                sequence_raw, self._expected_sequence
            )
            frames.append((sequence, payload))
        if len(self._buffer) > self._max_line_bytes:
            raise TransportProtocolError(
                code="oversized_line",
                detail=f"incomplete line exceeded {self._max_line_bytes} bytes",
            )
        return tuple(frames)

    @property
    def has_pending(self) -> bool:
        """Return whether a partial frame is buffered without its newline."""
        return bool(self._buffer)


@final
class JsonlEventReader:
    """Reads worker events from stdout, enforcing one terminal event."""

    __slots__: Final = ("_framing", "_terminal_received")

    def __init__(
        self,
        *,
        max_line_bytes: int = MAX_LINE_BYTES,
        max_total_bytes: int = MAX_TOTAL_BYTES,
    ) -> None:
        """Create an event reader with the given line and total byte limits."""
        self._framing = _Framing(
            payload_key="event",
            max_line_bytes=max_line_bytes,
            max_total_bytes=max_total_bytes,
        )
        self._terminal_received = False

    @property
    def terminal_received(self) -> bool:
        """Return whether the stream already observed its one terminal event."""
        return self._terminal_received

    @property
    def has_pending_input(self) -> bool:
        """Return whether a partial frame is buffered without its newline."""
        return self._framing.has_pending

    def feed(self, chunk: bytes) -> tuple[EventFrame, ...]:
        """Consume one byte chunk and return every finished event frame."""
        if self._terminal_received:
            raise TransportProtocolError(
                code="event_after_terminal",
                detail="no input is accepted after the terminal event",
            )
        frames: list[EventFrame] = []
        for sequence, payload in self._framing.consume(chunk):
            frames.append(self._build_frame(sequence, payload))
        return tuple(frames)

    def _build_frame(self, sequence: int, payload: FrameValue) -> EventFrame:
        """Decode and gate one event frame, enforcing the terminal contract."""
        if not isinstance(payload, dict):
            raise TransportProtocolError(
                code="malformed_json", detail="the event payload must be a JSON object"
            )
        kind = payload.get("kind")
        if not isinstance(kind, str) or kind not in _WORKER_EVENT_KINDS:
            raise TransportProtocolError(
                code="unknown_kind",
                detail="the event payload does not name a worker event",
            )
        try:
            decoded = decode_wire(json.dumps(payload))
        except IpcDecodeError as error:
            raise TransportProtocolError(
                code="invalid_event", detail=str(error)
            ) from error
        match decoded:
            case (
                WorkerReadyEvent()
                | StageChangedEvent()
                | ProgressEvent()
                | SucceededEvent()
                | FailedEvent()
                | CancelledEvent()
            ):
                pass
            case _:
                raise TransportProtocolError(
                    code="unknown_kind",
                    detail=f"message kind {kind!r} is not a worker event",
                )
        if self._terminal_received:
            if isinstance(decoded, (SucceededEvent, FailedEvent, CancelledEvent)):
                raise TransportProtocolError(
                    code="second_terminal_event",
                    detail="the worker emitted more than one terminal event",
                )
            raise TransportProtocolError(
                code="event_after_terminal",
                detail=f"message kind {kind!r} arrived after the terminal event",
            )
        if isinstance(decoded, (SucceededEvent, FailedEvent, CancelledEvent)):
            self._terminal_received = True
        return EventFrame(sequence=sequence, event=decoded)


@final
class JsonlCommandReader:
    """Reads GUI commands from stdin with the same framing contract."""

    __slots__: Final = ("_framing",)

    def __init__(
        self,
        *,
        max_line_bytes: int = MAX_LINE_BYTES,
        max_total_bytes: int = MAX_TOTAL_BYTES,
    ) -> None:
        """Create a command reader with the given line and total byte limits."""
        self._framing = _Framing(
            payload_key="command",
            max_line_bytes=max_line_bytes,
            max_total_bytes=max_total_bytes,
        )

    @property
    def has_pending_input(self) -> bool:
        """Return whether a partial frame is buffered without its newline."""
        return self._framing.has_pending

    def feed(self, chunk: bytes) -> tuple[CommandFrame, ...]:
        """Consume one byte chunk and return every finished command frame."""
        frames: list[CommandFrame] = []
        for sequence, payload in self._framing.consume(chunk):
            frames.append(self._build_frame(sequence, payload))
        return tuple(frames)

    def _build_frame(self, sequence: int, payload: FrameValue) -> CommandFrame:
        """Decode and gate one command frame against the command channel."""
        if not isinstance(payload, dict):
            raise TransportProtocolError(
                code="malformed_json",
                detail="the command payload must be a JSON object",
            )
        kind = payload.get("kind")
        if not isinstance(kind, str) or kind not in _COMMAND_KINDS:
            raise TransportProtocolError(
                code="unknown_kind",
                detail="the command payload does not name a GUI command",
            )
        try:
            decoded = decode_wire(json.dumps(payload))
        except IpcDecodeError as error:
            raise TransportProtocolError(
                code="invalid_command", detail=str(error)
            ) from error
        match decoded:
            case StartTaskCommand() | CancelTaskCommand() | ShutdownCommand():
                return CommandFrame(sequence=sequence, command=decoded)
            case _:
                raise TransportProtocolError(
                    code="unknown_kind",
                    detail=f"message kind {kind!r} is not a GUI command",
                )
