"""Tests for the worker Git clone handler's transport event contract.

The handler consumes a ``start_task`` envelope whose spec is a ``git_clone``,
emits ``stage_changed``/``progress`` events through the Todo 14 worker writer,
and emits exactly one terminal event: ``succeeded``, ``failed`` with an
actionable error code, or ``cancelled`` after cooperative cancellation.
"""

from __future__ import annotations

import io
from typing import TYPE_CHECKING

from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.ipc import (
    FailedEvent,
    StageChangedEvent,
    StartTaskCommand,
    WorkerEvent,
)
from hubfetch.domain.lifecycle import TransferStage
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.runtime.jsonl_transport import JsonlEventReader
from hubfetch.worker.git_handler import GitCloneHandler
from hubfetch.worker.handshake import WorkerEventWriter
from tests.git.conftest import VERSION_HANDLER, FakeGitHandler

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

TASK_ID = parse_task_id("task-git-1")
ATTEMPT_ID = parse_attempt_id("attempt-git-1")


def _command(destination: Path) -> StartTaskCommand:
    """Build one git_clone envelope targeting the given destination."""
    return StartTaskCommand(
        task_id=TASK_ID,
        attempt_id=ATTEMPT_ID,
        spec=GitCloneSpec(
            repository=RepositoryRef(
                repo_id=parse_repository_id("author/model"), kind=ModelRepository()
            ),
            destination=destination,
            auth_source=AuthSource.ANONYMOUS,
            proxy_mode=ProxyMode.SYSTEM,
        ),
    )


def _run_handler(
    command: StartTaskCommand,
    *,
    git_command: tuple[str, ...],
    environment: dict[str, str],
    cancel: Callable[[], bool] | None = None,
) -> tuple[int, tuple[WorkerEvent, ...]]:
    """Run the handler through a writer and return its exit code and events."""
    stream = io.BytesIO()
    writer = WorkerEventWriter(stream)
    handler = GitCloneHandler(
        git_command=git_command, environment=environment, cancel=cancel
    )
    exit_code = handler.handle(command, writer)
    frames = JsonlEventReader().feed(stream.getvalue())
    return exit_code, tuple(frame.event for frame in frames)


def test_git_handler_emits_stages_progress_and_succeeded(
    tmp_path: Path, fake_git: Callable[..., tuple[tuple[str, ...], dict[str, str]]]
) -> None:
    """Given a successful clone, the handler emits progress and one success."""
    handler = FakeGitHandler(
        match=("clone",),
        stderr=(
            ("Receiving objects: 50% (2/4)\n", 0.0),
            ("Updating files: 100% (4/4), done.\n", 0.0),
        ),
    )
    command, environment = fake_git([VERSION_HANDLER, handler])

    exit_code, events = _run_handler(
        _command(tmp_path / "dest"), git_command=command, environment=environment
    )

    assert [event.kind for event in events] == [
        "stage_changed",
        "stage_changed",
        "progress",
        "stage_changed",
        "progress",
        "succeeded",
    ]
    stages = [event.stage for event in events if isinstance(event, StageChangedEvent)]
    assert stages == [
        TransferStage.PREFLIGHT,
        TransferStage.TRANSFER,
        TransferStage.MATERIALIZE,
    ]
    assert events[-1].kind == "succeeded"
    assert exit_code == 0


def test_git_handler_emits_failed_with_actionable_error_code(
    tmp_path: Path, fake_git: Callable[..., tuple[tuple[str, ...], dict[str, str]]]
) -> None:
    """Given a network failure, the handler emits failed with the category code."""
    network_error = (
        "fatal: unable to access 'https://huggingface.co/x': Could not resolve host\n"
    )
    handler = FakeGitHandler(
        match=("clone",),
        stderr=((network_error, 0.0),),
        exit_code=128,
    )
    command, environment = fake_git([VERSION_HANDLER, handler])

    exit_code, events = _run_handler(
        _command(tmp_path / "dest"), git_command=command, environment=environment
    )

    assert isinstance(events[-1], FailedEvent)
    assert events[-1].error_code == "network"
    assert exit_code == 1


def test_git_handler_emits_cancelled_on_cooperative_cancel(
    tmp_path: Path, fake_git: Callable[..., tuple[tuple[str, ...], dict[str, str]]]
) -> None:
    """Given a cooperative cancel, the handler emits one cancelled terminal event."""
    handler = FakeGitHandler(
        match=("clone",),
        stderr=(
            ("first line\n", 1.0),
            ("second line\n", 1.0),
            ("third line\n", 1.0),
        ),
    )
    command, environment = fake_git([VERSION_HANDLER, handler])
    calls = 0

    def cancel() -> bool:
        nonlocal calls
        calls += 1
        return calls >= 2

    exit_code, events = _run_handler(
        _command(tmp_path / "dest"),
        git_command=command,
        environment=environment,
        cancel=cancel,
    )

    assert events[-1].kind == "cancelled"
    assert exit_code == 0


def test_git_handler_refuses_non_empty_destination(
    tmp_path: Path, fake_git: Callable[..., tuple[tuple[str, ...], dict[str, str]]]
) -> None:
    """Given a non-empty destination, the handler fails with the disk code."""
    destination = tmp_path / "dest"
    destination.mkdir()
    _ = (destination / "existing.txt").write_text("x", encoding="utf-8")
    command, environment = fake_git([VERSION_HANDLER])

    exit_code, events = _run_handler(
        _command(destination), git_command=command, environment=environment
    )

    assert isinstance(events[-1], FailedEvent)
    assert events[-1].error_code == "disk"
    assert exit_code == 1
