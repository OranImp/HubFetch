"""Canonical JSONL frame encoding and parsing primitives.

A frame is one JSON object ``{"sequence": <int>, "event"|"command": <wire
model>}``. Envelopes are validated with Pydantic (matching the domain
boundary's parse-don't-validate contract) and payloads are decoded by
:mod:`hubfetch.domain.ipc`. Every rejection is a typed
:class:`TransportProtocolError` with a stable machine-readable ``code``;
payload values are never echoed into rejection detail, so a malformed line
cannot leak a secret back into diagnostics. The incremental stream readers
live in :mod:`hubfetch.runtime.jsonl_transport`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Final, override

from pydantic import (
    BaseModel,
    ConfigDict,
    StrictInt,
    TypeAdapter,
    ValidationError,
)

if TYPE_CHECKING:
    from hubfetch.domain.ipc import GuiCommand, WorkerEvent

type FrameValue = (
    str | int | float | bool | list[FrameValue] | dict[str, FrameValue] | None
)
"""JSON values accepted in a frame envelope, typed precisely."""

MAX_LINE_BYTES: Final = 64 * 1024
"""Maximum bytes of one complete JSONL line."""
MAX_TOTAL_BYTES: Final = 8 * 1024 * 1024
"""Maximum cumulative bytes accepted by one reader before it fails closed."""


@dataclass(frozen=True, slots=True)
class TransportProtocolError(ValueError):
    """A typed rejection of one JSONL frame or stream."""

    code: str
    detail: str

    @override
    def __str__(self) -> str:
        return f"transport protocol error {self.code}: {self.detail}"


@dataclass(frozen=True, slots=True)
class EventFrame:
    """One decoded worker event frame with its transport sequence."""

    sequence: int
    event: WorkerEvent


@dataclass(frozen=True, slots=True)
class CommandFrame:
    """One decoded GUI command frame with its transport sequence."""

    sequence: int
    command: GuiCommand


class FrameModel(BaseModel):
    """The validated transport envelope surrounding one wire payload."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid")
    sequence: StrictInt
    event: FrameValue | None = None
    command: FrameValue | None = None


FRAME_ADAPTER: Final[TypeAdapter[FrameModel]] = TypeAdapter(FrameModel)


def encode_event_frame(event: WorkerEvent, sequence: int) -> bytes:
    """Encode one worker event as a sequenced JSONL frame."""
    return _encode_line({"sequence": sequence, "event": event.model_dump(mode="json")})


def encode_command_frame(command: GuiCommand, sequence: int) -> bytes:
    """Encode one GUI command as a sequenced JSONL frame."""
    return _encode_line(
        {"sequence": sequence, "command": command.model_dump(mode="json")}
    )


def _encode_line(payload: dict[str, object]) -> bytes:
    """Serialize one frame dict as a single canonical UTF-8 JSON line."""
    return (
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")


def _map_frame_error(error: ValidationError) -> TransportProtocolError:
    """Map one Pydantic frame rejection to a stable transport error code."""
    for detail in error.errors():
        location = ".".join(str(part) for part in detail["loc"])
        error_type = detail["type"]
        if "sequence" in location:
            return TransportProtocolError(
                code="invalid_sequence",
                detail=f"the sequence field is invalid at {location or 'root'}",
            )
        if error_type in {"json_invalid", "extra_forbidden", "missing", "model_type"}:
            return TransportProtocolError(
                code="malformed_json",
                detail=f"the frame shape is invalid at {location or 'root'}",
            )
    return TransportProtocolError(
        code="malformed_json", detail="the frame shape is invalid"
    )


def parse_frame(line: bytes, payload_key: str) -> tuple[int, FrameValue]:
    """Parse one complete line into its ``(sequence, payload)`` values."""
    if not line.strip():
        raise TransportProtocolError(
            code="empty_line", detail="blank lines are not valid JSONL frames"
        )
    try:
        text = line.decode("utf-8")
    except UnicodeDecodeError:
        raise TransportProtocolError(
            code="invalid_utf8", detail="a frame line is not valid UTF-8"
        ) from None
    try:
        model = FRAME_ADAPTER.validate_json(text)
    except ValidationError as error:
        raise _map_frame_error(error) from error
    payload: FrameValue | None = (
        model.event if model.event is not None else model.command
    )
    if payload is None:
        raise TransportProtocolError(
            code="malformed_json",
            detail=f"a frame must carry a {payload_key!r} payload",
        )
    return model.sequence, payload


def validate_sequence(raw: int, expected: int) -> tuple[int, int]:
    """Validate one sequence token, returning it and the next expected value."""
    if raw < 0:
        raise TransportProtocolError(
            code="invalid_sequence", detail="sequence must be non-negative"
        )
    if raw == expected:
        return raw, expected + 1
    if raw == expected - 1:
        raise TransportProtocolError(
            code="duplicate_sequence", detail=f"sequence {raw} was already consumed"
        )
    raise TransportProtocolError(
        code="out_of_order_sequence",
        detail=f"expected sequence {expected}, received {raw}",
    )
