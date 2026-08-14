"""Tests for the worker handshake writer, bounded envelope read, and dispatch.

These pure tests cover the sequenced event writer, the bounded stdin envelope
read, the worker entry-point dispatch, and argv/environment secret absence on
every platform. Windows integration through the QProcess transport lives in
``test_worker_process.py``.
"""

from __future__ import annotations

import io
import sys
from typing import TYPE_CHECKING, Final

import pytest

from hubfetch.domain.ipc import (
    FailedEvent,
    ShutdownCommand,
    WorkerReadyEvent,
)
from hubfetch.runtime.jsonl_transport import (
    EventFrame,
    JsonlEventReader,
    encode_command_frame,
)
from hubfetch.runtime.process_environment import environment_mapping
from hubfetch.runtime.worker_command import build_worker_argv
from hubfetch.worker.handshake import (
    WorkerEventWriter,
    WorkerHandshakeError,
    read_envelope,
)
from hubfetch.worker.main import TRANSFER_HANDLER_UNAVAILABLE, main
from tests.runtime.worker_fixtures import (
    ATTEMPT_ID,
    TASK_ID,
    ChunkedStream,
    PipedStdio,
    start_task_command,
    worker_environment,
)

if TYPE_CHECKING:
    from pathlib import Path

HF_TEST_SECRET: Final = "hf_test_secret_123"  # noqa: S105


def test_worker_ready_event_is_sequence_zero() -> None:
    """Given a fresh writer, the first event is a sequence-zero ready frame."""
    stream = io.BytesIO()
    writer = WorkerEventWriter(stream)

    writer.emit(WorkerReadyEvent())

    frames = JsonlEventReader().feed(stream.getvalue())
    assert frames == (EventFrame(sequence=0, event=WorkerReadyEvent()),)


def test_event_writer_increments_sequence() -> None:
    """Given several emissions, the writer numbers frames strictly increasing."""
    stream = io.BytesIO()
    writer = WorkerEventWriter(stream)

    writer.emit(WorkerReadyEvent())
    writer.emit(FailedEvent(task_id=TASK_ID, attempt_id=ATTEMPT_ID, error_code="probe"))

    frames = JsonlEventReader().feed(stream.getvalue())
    assert [frame.sequence for frame in frames] == [0, 1]
    assert frames[1].event.kind == "failed"
    assert frames[1].event.error_code == "probe"


def test_read_envelope_returns_complete_frame() -> None:
    """Given a ready envelope, the reader returns the decoded command frame."""
    stream = ChunkedStream([encode_command_frame(ShutdownCommand(), 0)])

    frames = read_envelope(stream)

    assert frames[0].sequence == 0
    assert frames[0].command == ShutdownCommand()


def test_read_envelope_streams_across_reads() -> None:
    """Given a frame split across reads, the reader still returns it."""
    line = encode_command_frame(ShutdownCommand(), 0)
    stream = ChunkedStream([line[:7], line[7:20], line[20:]])

    frames = read_envelope(stream)

    assert frames[0].command == ShutdownCommand()


def test_read_envelope_eof_before_envelope_is_typed() -> None:
    """Given an empty stream, the reader reports a typed EOF failure."""
    with pytest.raises(WorkerHandshakeError) as raised:
        _ = read_envelope(ChunkedStream([]))

    assert raised.value.code == "eof_before_envelope"


def test_read_envelope_eof_mid_frame_is_typed() -> None:
    """Given a partial frame then EOF, the reader reports an incomplete frame."""
    with pytest.raises(WorkerHandshakeError) as raised:
        _ = read_envelope(ChunkedStream([b'{"sequence": 0, "command":']))

    assert raised.value.code == "eof_incomplete_frame"


def test_read_envelope_rejects_malformed_frame() -> None:
    """Given malformed JSON, the reader surfaces the typed protocol failure."""
    with pytest.raises(WorkerHandshakeError) as raised:
        _ = read_envelope(ChunkedStream([b"{not-json}\n"]))

    assert raised.value.code == "malformed_json"


def test_main_shutdown_probe_exits_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """Given a shutdown probe, the real worker emits ready and exits cleanly."""
    stdin = io.BytesIO(encode_command_frame(ShutdownCommand(), 0))
    stdout = io.BytesIO()
    monkeypatch.setattr(sys, "stdin", PipedStdio(stdin))
    monkeypatch.setattr(sys, "stdout", PipedStdio(stdout))

    assert main(["--worker", "session-5"]) == 0

    frames = JsonlEventReader().feed(stdout.getvalue())
    assert [frame.event.kind for frame in frames] == ["worker_ready"]


def test_main_start_task_releases_destination_and_fails_typed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Given a start_task envelope, the stub proves release then fails typed."""
    destination = tmp_path / "destination"
    command = start_task_command(destination)
    stdin = io.BytesIO(encode_command_frame(command, 0))
    stdout = io.BytesIO()
    monkeypatch.setattr(sys, "stdin", PipedStdio(stdin))
    monkeypatch.setattr(sys, "stdout", PipedStdio(stdout))

    assert main(["--worker", "session-6"]) == 1
    assert destination.exists()

    frames = JsonlEventReader().feed(stdout.getvalue())
    assert [frame.event.kind for frame in frames] == ["worker_ready", "failed"]
    failed = frames[1].event
    assert isinstance(failed, FailedEvent)
    assert failed.error_code == TRANSFER_HANDLER_UNAVAILABLE


def test_main_rejects_task_details_in_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    """Given task details in argv, the worker refuses to start."""
    stdout = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", PipedStdio(stdout))

    assert main(["--worker", "session-7", "--task", "spec"]) == 2
    assert stdout.getvalue() == b""


def test_main_rejects_unknown_argv_without_emitting_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given an unknown argv shape, no ready event is ever emitted."""
    stdout = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", PipedStdio(stdout))

    assert main(["bogus"]) == 2
    assert stdout.getvalue() == b""


def test_sanitized_worker_environment_never_carries_secret_bytes() -> None:
    """Given a poisoned parent, the sanitized child carries no secret bytes."""
    values = environment_mapping(worker_environment())
    joined = "".join(f"{name}={value}" for name, value in values.items())

    assert "GIT_ASKPASS" not in values
    assert "SSH_ASKPASS" not in values
    assert "HF_TOKEN" not in values
    assert "HUGGING_FACE_HUB_TOKEN" not in values
    assert "HUBFETCH_SENTINEL" not in values
    assert HF_TEST_SECRET not in joined
    assert "legacy-token" not in joined
    assert "must-not-leak" not in joined


def test_worker_argv_and_environment_join_contains_no_sentinel() -> None:
    """Given the real argv and sanitized env, their joined text has no sentinel."""
    argv = build_worker_argv(session_locator="session-8", frozen=False)
    env_text = "".join(
        f"{name}={value}"
        for name, value in environment_mapping(worker_environment()).items()
    )

    joined = " ".join(argv) + "|" + env_text

    assert HF_TEST_SECRET not in joined
    assert "legacy-token" not in joined
    assert "must-not-leak" not in joined
