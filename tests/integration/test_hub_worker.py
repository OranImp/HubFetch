"""Integration tests for the worker Hub download handler's event contract.

Given/When/Then throughout. The handler consumes a ``start_task`` envelope for
a download spec, drives the real pinned ``huggingface_hub`` library against the
Hub-compatible HTTP fixture, emits ``stage_changed``/``progress`` events through
the Todo 14 worker writer, and emits exactly one terminal event: ``succeeded``,
``failed`` with an actionable error code, or ``cancelled`` after cooperative
cancellation or a control-reader cancel command.
"""

from __future__ import annotations

import io
import os
import threading
import time
from typing import TYPE_CHECKING, BinaryIO, Final

import pytest

from hubfetch.domain.ids import parse_attempt_id, parse_task_id
from hubfetch.domain.ipc import (
    CancelTaskCommand,
    FailedEvent,
    StartTaskCommand,
    WorkerEvent,
)
from hubfetch.domain.lifecycle import TransferStage
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    GitCloneSpec,
    PreserveExisting,
    ProxyMode,
    SingleFileDownloadSpec,
)
from hubfetch.runtime.jsonl_framing import encode_command_frame
from hubfetch.runtime.jsonl_transport import JsonlEventReader
from hubfetch.worker.handshake import WorkerEventWriter
from hubfetch.worker.hub_handler import HubDownloadHandler

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from tests.hub.fixtures import HubFixtureServer

from tests.hub.fixtures import hub_fixture
from tests.hub.helpers import make_repository

BIG_FILE_BYTES: Final = 11 * 1024 * 1024
TASK_ID = parse_task_id("task-hub-download-1")
ATTEMPT_ID = parse_attempt_id("attempt-hub-download-1")
_POLL_INTERVAL_SECONDS: Final = 0.02


def _file_command(filename: str) -> StartTaskCommand:
    """Build one single-file download envelope into the Hub cache."""
    return StartTaskCommand(
        task_id=TASK_ID,
        attempt_id=ATTEMPT_ID,
        spec=SingleFileDownloadSpec(
            repository=make_repository(),
            filename=filename,
            destination=CacheDestination(),
            conflict_policy=PreserveExisting(),
            auth_source=AuthSource.ANONYMOUS,
            proxy_mode=ProxyMode.SYSTEM,
        ),
    )


def _run_handler(
    command: StartTaskCommand,
    *,
    endpoint: str,
    cache_dir: Path,
    cancel: Callable[[], bool] | None = None,
    command_stream: BinaryIO | None = None,
) -> tuple[int, tuple[WorkerEvent, ...]]:
    """Run the handler through a writer and return its exit code and events."""
    stream = io.BytesIO()
    writer = WorkerEventWriter(stream)
    handler = HubDownloadHandler(
        endpoint=endpoint,
        cache_dir=cache_dir,
        cancel=cancel,
        command_stream=command_stream,
    )
    exit_code = handler.handle(command, writer)
    frames = JsonlEventReader().feed(stream.getvalue())
    return exit_code, tuple(frame.event for frame in frames)


def _terminal_count(events: tuple[WorkerEvent, ...]) -> int:
    """Count the terminal worker events in one event stream."""
    return sum(
        1 for event in events if event.kind in {"succeeded", "failed", "cancelled"}
    )


def _wait_for_download_start(fixture: HubFixtureServer) -> None:
    """Wait for the fixture to observe the first download GET within a bound."""
    deadline = time.monotonic() + 20.0
    while not any(entry["method"] == "GET" for entry in fixture.request_log):
        if time.monotonic() > deadline:
            pytest.fail("fixture never received the download GET")
        time.sleep(_POLL_INTERVAL_SECONDS)


class TestHubDownloadHandlerSuccess:
    """Given a successful download, the handler reports the full stage flow."""

    def test_emits_stages_progress_and_one_succeeded(self, tmp_path: Path) -> None:
        content = b"handler-config-content"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            exit_code, events = _run_handler(
                _file_command("config.json"),
                endpoint=fixture.endpoint,
                cache_dir=tmp_path / "cache",
            )
        stages = [event.stage for event in events if event.kind == "stage_changed"]
        assert stages == [
            TransferStage.PREFLIGHT,
            TransferStage.TRANSFER,
            TransferStage.MATERIALIZE,
            TransferStage.FINALIZE,
        ]
        progress = [event for event in events if event.kind == "progress"]
        assert progress
        assert _terminal_count(events) == 1
        assert events[-1].kind == "succeeded"
        assert exit_code == 0

    def test_progress_bytes_are_monotonic_and_bounded(self, tmp_path: Path) -> None:
        content = b"handler-monotonic-content"
        with hub_fixture(
            files=[("config.json", len(content))], content={"config.json": content}
        ) as fixture:
            exit_code, events = _run_handler(
                _file_command("config.json"),
                endpoint=fixture.endpoint,
                cache_dir=tmp_path / "cache",
            )
        progress = [event for event in events if event.kind == "progress"]
        done = [event.bytes_done for event in progress]
        assert done == sorted(done)
        assert all(event.bytes_total >= event.bytes_done for event in progress)
        assert exit_code == 0


class TestHubDownloadHandlerCancellation:
    """Given cooperative cancellation, the handler unwinds and reports cancelled."""

    def test_emits_cancelled_on_cooperative_cancel(self, tmp_path: Path) -> None:
        content = b"z" * BIG_FILE_BYTES
        with hub_fixture(
            files=[("big.bin", len(content))], content={"big.bin": content}
        ) as fixture:
            calls = {"n": 0}

            def cancel() -> bool:
                calls["n"] += 1
                return calls["n"] >= 4

            exit_code, events = _run_handler(
                _file_command("big.bin"),
                endpoint=fixture.endpoint,
                cache_dir=tmp_path / "cache",
                cancel=cancel,
            )
        assert events[-1].kind == "cancelled"
        assert _terminal_count(events) == 1
        assert exit_code == 0

    def test_control_reader_cancels_through_pipe(self, tmp_path: Path) -> None:
        content = b"y" * BIG_FILE_BYTES
        with hub_fixture(
            files=[("big.bin", len(content))], content={"big.bin": content}
        ) as fixture:
            read_fd, write_fd = os.pipe()
            with (
                os.fdopen(read_fd, "rb") as read_stream,
                os.fdopen(write_fd, "wb") as write_stream,
            ):
                command = _file_command("big.bin")
                writer_stream = io.BytesIO()
                writer = WorkerEventWriter(writer_stream)
                handler = HubDownloadHandler(
                    endpoint=fixture.endpoint,
                    cache_dir=tmp_path / "cache",
                    command_stream=read_stream,
                )
                outcome: list[int] = []

                def run() -> None:
                    outcome.append(handler.handle(command, writer))

                thread = threading.Thread(target=run, daemon=True)
                thread.start()
                _wait_for_download_start(fixture)
                cancel_frame = encode_command_frame(
                    CancelTaskCommand(task_id=TASK_ID, attempt_id=ATTEMPT_ID), 1
                )
                write_stream.write(cancel_frame)
                write_stream.flush()
                thread.join(30.0)
                if thread.is_alive():
                    pytest.fail("handler did not finish after the cancel command")
        assert not thread.is_alive()
        events = tuple(
            frame.event for frame in JsonlEventReader().feed(writer_stream.getvalue())
        )
        assert events[-1].kind == "cancelled"
        assert _terminal_count(events) == 1
        assert outcome[0] == 0


class TestHubDownloadHandlerFailure:
    """Given a failing or refused download, the handler reports a typed outcome."""

    def test_emits_failed_with_sanitized_error_code(self, tmp_path: Path) -> None:
        with hub_fixture(files=(), error="repo_not_found") as fixture:
            exit_code, events = _run_handler(
                _file_command("config.json"),
                endpoint=fixture.endpoint,
                cache_dir=tmp_path / "cache",
            )
        assert isinstance(events[-1], FailedEvent)
        assert events[-1].error_code in {"authentication", "not_found"}
        assert "secret" not in events[-1].error_code
        assert _terminal_count(events) == 1
        assert exit_code == 1

    def test_refuses_git_clone_spec(self, tmp_path: Path) -> None:
        command = StartTaskCommand(
            task_id=TASK_ID,
            attempt_id=ATTEMPT_ID,
            spec=GitCloneSpec(
                repository=make_repository(),
                destination=tmp_path / "clone",
                auth_source=AuthSource.ANONYMOUS,
                proxy_mode=ProxyMode.SYSTEM,
            ),
        )
        with hub_fixture(files=()) as fixture:
            exit_code, events = _run_handler(
                command, endpoint=fixture.endpoint, cache_dir=tmp_path / "cache"
            )
        assert isinstance(events[-1], FailedEvent)
        assert events[-1].error_code == "internal"
        assert _terminal_count(events) == 1
        assert exit_code == 1
