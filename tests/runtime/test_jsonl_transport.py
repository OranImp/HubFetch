"""Tests for the incremental UTF-8 JSONL worker transport.

The reader is the strict boundary between the worker's stdout pipe and the
GUI; every protocol rejection is typed.
"""

from __future__ import annotations

import pytest

from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.ipc import (
    CancelTaskCommand,
    FailedEvent,
    ProgressEvent,
    ShutdownCommand,
    StartTaskCommand,
    SucceededEvent,
    WorkerReadyEvent,
)
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)
from hubfetch.runtime.jsonl_transport import (
    EventFrame,
    JsonlCommandReader,
    JsonlEventReader,
    TransportProtocolError,
    encode_command_frame,
    encode_event_frame,
)

TASK_ID = parse_task_id("task-1")
ATTEMPT_ID = parse_attempt_id("attempt-1")

_SPEC = SingleFileDownloadSpec(
    repository=RepositoryRef(
        repo_id=parse_repository_id("author/name"), kind=ModelRepository()
    ),
    filename="config.json",
    destination=CacheDestination(),
    conflict_policy=OverwriteExisting(),
    auth_source=AuthSource.ANONYMOUS,
    proxy_mode=ProxyMode.SYSTEM,
)


def _ready_line() -> bytes:
    return encode_event_frame(WorkerReadyEvent(), 0)


def _succeeded_line() -> bytes:
    return encode_event_frame(SucceededEvent(task_id=TASK_ID, attempt_id=ATTEMPT_ID), 1)


def _start_task_line() -> bytes:
    return encode_command_frame(
        StartTaskCommand(task_id=TASK_ID, attempt_id=ATTEMPT_ID, spec=_SPEC), 0
    )


def _rejection(
    chunk: bytes, *, max_line_bytes: int = 64 * 1024
) -> TransportProtocolError:
    """Run one chunk through a fresh reader and return the typed rejection."""
    with pytest.raises(TransportProtocolError) as raised:
        _ = JsonlEventReader(max_line_bytes=max_line_bytes).feed(chunk)
    return raised.value


def test_worker_ready_frame_round_trip() -> None:
    """Given an encoded ready frame, the reader yields the typed ready event."""
    reader = JsonlEventReader()
    frames = reader.feed(_ready_line())

    assert frames == (EventFrame(sequence=0, event=WorkerReadyEvent()),)


def test_worker_event_round_trip_preserves_fields() -> None:
    """Given an encoded progress event, the reader preserves every field."""
    event = ProgressEvent(
        task_id=TASK_ID,
        attempt_id=ATTEMPT_ID,
        bytes_done=10,
        bytes_total=100,
    )
    reader = JsonlEventReader()

    frames = reader.feed(encode_event_frame(event, 0))

    assert frames[0].sequence == 0
    assert frames[0].event == event


def test_command_frame_round_trip() -> None:
    """Given an encoded start_task envelope, the command reader decodes it."""
    reader = JsonlCommandReader()

    frames = reader.feed(_start_task_line())

    assert frames[0].sequence == 0
    assert isinstance(frames[0].command, StartTaskCommand)
    assert frames[0].command.spec == _SPEC


def test_shutdown_command_round_trip() -> None:
    """Given an encoded shutdown probe, the command reader decodes it."""
    reader = JsonlCommandReader()

    frames = reader.feed(encode_command_frame(ShutdownCommand(), 0))

    assert frames[0].sequence == 0
    assert frames[0].command == ShutdownCommand()


def test_incremental_chunks_yield_one_frame_after_the_newline() -> None:
    """Given bytes split across three feeds, the frame yields only at the end."""
    reader = JsonlEventReader()
    line = _ready_line()
    first, middle, last = line[:5], line[5:20], line[20:]

    assert reader.feed(first) == ()
    assert reader.feed(middle) == ()
    frames = reader.feed(last)

    assert frames == (EventFrame(sequence=0, event=WorkerReadyEvent()),)


def test_coalesced_lines_yield_frames_in_arrival_order() -> None:
    """Given two frames in one chunk, both yield in order."""
    reader = JsonlEventReader()

    frames = reader.feed(_ready_line() + _succeeded_line())

    assert [frame.sequence for frame in frames] == [0, 1]
    assert isinstance(frames[0].event, WorkerReadyEvent)
    assert isinstance(frames[1].event, SucceededEvent)


def test_sequence_must_start_at_zero() -> None:
    """Given a first frame with sequence one, the reader rejects the stream."""
    error = _rejection(encode_event_frame(WorkerReadyEvent(), 1))

    assert error.code == "out_of_order_sequence"


def test_duplicate_sequence_is_rejected() -> None:
    """Given the same sequence twice, the second frame is a duplicate."""
    reader = JsonlEventReader()
    _ = reader.feed(_ready_line())

    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(
            encode_event_frame(
                SucceededEvent(task_id=TASK_ID, attempt_id=ATTEMPT_ID), 0
            )
        )

    assert raised.value.code == "duplicate_sequence"


def test_out_of_order_sequence_is_rejected() -> None:
    """Given a sequence that skips ahead, the reader reports out-of-order."""
    reader = JsonlEventReader()
    _ = reader.feed(_ready_line())

    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(
            encode_event_frame(
                SucceededEvent(task_id=TASK_ID, attempt_id=ATTEMPT_ID), 3
            )
        )

    assert raised.value.code == "out_of_order_sequence"


def test_invalid_sequence_tokens_are_rejected() -> None:
    """Given non-integer or negative tokens, the reader rejects them."""
    for frame in (
        b'{"sequence": "0", "event": {"kind": "worker_ready"}}\n',
        b'{"sequence": -1, "event": {"kind": "worker_ready"}}\n',
    ):
        error = _rejection(frame)
        assert error.code == "invalid_sequence"


def test_oversized_line_is_rejected() -> None:
    """Given a single line beyond the limit, the reader rejects it."""
    error = _rejection(_ready_line(), max_line_bytes=4)

    assert error.code == "oversized_line"


def test_oversized_total_is_rejected() -> None:
    """Given cumulative input past the limit, the reader rejects it."""
    reader = JsonlEventReader(max_total_bytes=8)
    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(b'{"sequence": 0' + b'0, "event"')

    assert raised.value.code == "oversized_total"


def test_malformed_json_is_rejected() -> None:
    """Given a line that is not valid JSON, the reader rejects it."""
    error = _rejection(b'{"sequence": 0, "event": {not-json}\n')

    assert error.code == "malformed_json"


def test_empty_line_is_rejected() -> None:
    """Given a blank line, the reader rejects it as malformed framing."""
    error = _rejection(b"\n")

    assert error.code == "empty_line"


def test_non_object_frame_is_rejected() -> None:
    """Given a JSON array instead of an object, the reader rejects it."""
    error = _rejection(b"[1, 2, 3]\n")

    assert error.code == "malformed_json"


def test_frame_missing_payload_key_is_rejected() -> None:
    """Given a frame without an event payload, the reader rejects it."""
    error = _rejection(b'{"sequence": 0}\n')

    assert error.code == "malformed_json"


def test_unknown_kind_is_rejected() -> None:
    """Given an unknown kind tag, the reader rejects it."""
    error = _rejection(b'{"sequence": 0, "event": {"kind": "bogus"}}\n')

    assert error.code == "unknown_kind"


def test_non_worker_message_on_the_event_channel_is_rejected() -> None:
    """Given a GUI command on the event channel, the reader rejects it."""
    error = _rejection(_start_task_line())

    assert error.code == "unknown_kind"


def test_invalid_event_fields_are_rejected() -> None:
    """Given a known kind with an invalid field, the reader rejects it."""
    frame = (
        b'{"sequence": 0, "event": {"kind": "progress", "task_id": "task-1",'
        b' "attempt_id": "attempt-1", "bytes_done": -1, "bytes_total": 100}}\n'
    )

    error = _rejection(frame)

    assert error.code == "invalid_event"


def test_invalid_utf8_is_rejected() -> None:
    """Given a non-UTF-8 byte sequence, the reader rejects it."""
    error = _rejection(b"\xff\xfe invalid\n")

    assert error.code == "invalid_utf8"


def test_second_terminal_event_is_rejected() -> None:
    """Given two terminal events in one chunk, the second is rejected."""
    reader = JsonlEventReader()
    _ = reader.feed(_ready_line())

    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(
            _succeeded_line()
            + encode_event_frame(
                FailedEvent(task_id=TASK_ID, attempt_id=ATTEMPT_ID, error_code="x"), 2
            )
        )

    assert raised.value.code == "second_terminal_event"


def test_non_terminal_event_after_terminal_is_rejected() -> None:
    """Given any event after the terminal event, the stream is rejected."""
    reader = JsonlEventReader()
    _ = reader.feed(_ready_line())
    _ = reader.feed(_succeeded_line())

    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(
            encode_event_frame(
                ProgressEvent(
                    task_id=TASK_ID, attempt_id=ATTEMPT_ID, bytes_done=1, bytes_total=1
                ),
                2,
            )
        )

    assert raised.value.code == "event_after_terminal"


def test_reader_stops_accepting_input_after_terminal() -> None:
    """Given a terminal already observed, any further feed fails closed."""
    reader = JsonlEventReader()
    _ = reader.feed(_ready_line())
    _ = reader.feed(_succeeded_line())
    assert reader.terminal_received

    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(b"\n")

    assert raised.value.code == "event_after_terminal"


def test_command_reader_rejects_worker_events() -> None:
    """Given a worker event on the command channel, the reader rejects it."""
    with pytest.raises(TransportProtocolError) as raised:
        _ = JsonlCommandReader().feed(_ready_line())

    assert raised.value.code == "unknown_kind"


def test_command_reader_rejects_duplicate_sequence() -> None:
    """Given a repeated command sequence, the reader rejects it."""
    reader = JsonlCommandReader()
    _ = reader.feed(_start_task_line())
    _ = reader.feed(encode_command_frame(ShutdownCommand(), 1))

    with pytest.raises(TransportProtocolError) as raised:
        _ = reader.feed(encode_command_frame(ShutdownCommand(), 1))

    assert raised.value.code == "duplicate_sequence"


def test_cancel_command_round_trip() -> None:
    """Given an encoded cancel command, the command reader decodes it."""
    reader = JsonlCommandReader()

    frames = reader.feed(
        encode_command_frame(
            CancelTaskCommand(task_id=TASK_ID, attempt_id=ATTEMPT_ID), 0
        )
    )

    assert isinstance(frames[0].command, CancelTaskCommand)


def test_protocol_error_renders_without_echoing_payloads() -> None:
    """Given a rejection, its message names only the code and reason."""
    error = _rejection(b'{"sequence": 0, "event": {"kind": "bogus"}}\n')

    rendered = str(error)

    assert "unknown_kind" in rendered
    assert "bogus" not in rendered
