"""Given/When/Then contracts for the task action model.

Todo 26: the action model must compute the valid action set truthfully for
every lifecycle state, keep ``cancelling`` active until a terminal snapshot,
refuse a second cancel, link Retry to the seam while enforcing Git's
new/empty-destination rule via the :attr:`destination_required` signal, open
folders only for existing safe local directories, and always produce a
sanitized diagnostic summary with no secret material surviving.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from hubfetch.domain.ids import parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.task_spec import LocalDirectoryDestination
from hubfetch.security.redaction import SecretRegistry
from hubfetch.ui.tasks.actions import TaskActionModel, TaskCommands

from .helpers import cache_spec, detail, git_spec, single_file_spec, snapshot

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.domain.ids import TaskId

_ALL_STATES: tuple[LifecycleState, ...] = (
    LifecycleState.QUEUED,
    LifecycleState.RUNNING,
    LifecycleState.CANCELLING,
    LifecycleState.SUCCEEDED,
    LifecycleState.FAILED,
    LifecycleState.CANCELLED,
    LifecycleState.INTERRUPTED,
)


def _task_id() -> TaskId:
    """Return one stable task id for the action tests."""
    return parse_task_id("task-1")


def _cancellable_states() -> tuple[LifecycleState, ...]:
    """Return the states where Cancel must be offered."""
    return (LifecycleState.QUEUED, LifecycleState.RUNNING)


def _retryable_states() -> tuple[LifecycleState, ...]:
    """Return the states where Retry must be offered."""
    return (
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
    )


def _build(commands: TaskCommands | None = None) -> TaskActionModel:
    """Build one action model over an empty detail."""
    model = TaskActionModel(commands or TaskCommands())
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.QUEUED)))
    return model


def _full_commands() -> TaskCommands:
    """Return a seam with every command wired (no-op) for state-table tests."""
    return TaskCommands(
        cancel=lambda task_id: None,
        retry=lambda task_id: None,
        open_folder=lambda path: None,
    )


def _record_cancel(calls: list[TaskId]) -> Callable[[TaskId], None]:
    """Return a cancel seam that records each fired task id."""

    def cancel(task_id: TaskId) -> None:
        calls.append(task_id)

    return cancel


def _record_retry(calls: list[TaskId]) -> Callable[[TaskId], None]:
    """Return a retry seam that records each fired task id."""

    def retry(task_id: TaskId) -> None:
        calls.append(task_id)

    return retry


def _record_open(opened: list[Path]) -> Callable[[Path], None]:
    """Return an open-folder seam that records each opened path."""

    def open_folder(path: Path) -> None:
        opened.append(path)

    return open_folder


def test_cancel_valid_only_for_queued_and_running() -> None:
    """Given every state, when queried, then Cancel matches the domain rule."""
    model = _build(_full_commands())
    for state in _ALL_STATES:
        model.apply_detail(detail(snapshot(_task_id(), state)))
        assert model.can_cancel() == (state in _cancellable_states()), state


def test_retry_valid_only_for_retryable_states() -> None:
    """Given every state, when queried, then Retry matches the domain rule."""
    model = _build(_full_commands())
    for state in _ALL_STATES:
        model.apply_detail(detail(snapshot(_task_id(), state)))
        assert model.can_retry() == (state in _retryable_states()), state


def test_retry_disabled_when_seam_absent() -> None:
    """Given no retry seam, when queried, then Retry is disabled in every state."""
    model = _build(TaskCommands())
    for state in _retryable_states():
        model.apply_detail(detail(snapshot(_task_id(), state)))
        assert not model.can_retry()


def test_cancel_disabled_when_seam_absent() -> None:
    """Given no cancel seam, when queried, then Cancel is disabled."""
    model = _build(TaskCommands())
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.RUNNING)))
    assert not model.can_cancel()


def test_queued_cancel_fires_seam_immediately() -> None:
    """Given a queued task, when cancelling, then the seam fires once."""
    calls: list[TaskId] = []
    model = _build(TaskCommands(cancel=_record_cancel(calls)))
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.QUEUED)))

    model.request_cancel()

    assert calls == [_task_id()]


def test_cancel_truthfulness_active_until_terminal(qtbot: QtBot) -> None:
    """Given a cancel in flight, when snapshots advance, then it stays visible."""
    _ = qtbot
    calls: list[TaskId] = []
    model = _build(TaskCommands(cancel=_record_cancel(calls)))
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.RUNNING)))

    model.request_cancel()

    assert model.cancelling_active()
    # The runtime has not terminalized yet; cancel stays visible and one-shot.
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.RUNNING)))
    assert model.cancelling_active()
    assert model.can_cancel()
    model.request_cancel()
    assert calls == [_task_id()]  # no second cancel fired
    # CANCELLING is nonterminal: still visible, still no second cancel.
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.CANCELLING)))
    assert model.cancelling_active()
    assert not model.can_cancel()
    model.request_cancel()
    assert calls == [_task_id()]
    # The terminal snapshot closes the cancel window.
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.CANCELLED)))
    assert not model.cancelling_active()


def test_cancelling_state_visible_without_prior_request() -> None:
    """Given a CANCELLING snapshot with no prior request, when queried, active."""
    model = _build()
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.CANCELLING)))
    assert model.cancelling_active()
    assert not model.can_cancel()


def test_retry_fires_seam_for_plain_download() -> None:
    """Given a failed download, when retrying, then the seam fires once."""
    calls: list[TaskId] = []
    model = _build(TaskCommands(retry=_record_retry(calls)))
    model.apply_detail(detail(snapshot(_task_id(), LifecycleState.FAILED)))

    model.request_retry()

    assert calls == [_task_id()]
    assert not model.retry_needs_destination()


def test_git_retry_empty_destination_fires_seam() -> None:
    """Given a Git failure with an empty destination, when retrying, seam fires."""
    calls: list[TaskId] = []
    model = _build(TaskCommands(retry=_record_retry(calls)))
    task = snapshot(
        _task_id(), LifecycleState.FAILED, spec=git_spec(destination="E:\\clone")
    )
    model.apply_detail(detail(task))

    model.request_retry()

    assert calls == [_task_id()]
    assert not model.retry_needs_destination()


def test_git_retry_nonempty_destination_demands_new_destination(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a non-empty Git destination, when retrying, destination_required."""
    _ = qtbot
    destination = tmp_path / "existing"
    destination.mkdir()
    _ = (destination / "partial.bin").write_bytes(b"partial")
    calls: list[TaskId] = []
    model = _build(TaskCommands(retry=_record_retry(calls)))
    task = snapshot(
        _task_id(), LifecycleState.INTERRUPTED, spec=git_spec(str(destination))
    )
    model.apply_detail(detail(task))
    demanded: list[TaskId] = []

    def on_destination_required(
        task_id: TaskId, demanded: list[TaskId] = demanded
    ) -> None:
        demanded.append(task_id)

    _ = model.destination_required.connect(on_destination_required)

    model.request_retry()

    assert demanded == [_task_id()]
    assert calls == []
    assert model.retry_needs_destination()


def test_git_retry_missing_destination_is_new() -> None:
    """Given an absent Git destination, when queried, then it is a valid target."""
    model = _build(TaskCommands(retry=lambda task_id: None))
    task = snapshot(
        _task_id(),
        LifecycleState.FAILED,
        spec=git_spec(destination="E:\\absent-clone"),
    )
    model.apply_detail(detail(task))
    assert not model.retry_needs_destination()


def test_open_folder_only_for_existing_safe_directory(
    tmp_path: Path,
) -> None:
    """Given destinations, when queried, then Open Folder follows safe rules."""
    existing = tmp_path / "existing"
    existing.mkdir()
    opened: list[Path] = []
    model = TaskActionModel(TaskCommands(open_folder=_record_open(opened)))
    task = snapshot(_task_id(), LifecycleState.SUCCEEDED, spec=git_spec(str(existing)))
    model.apply_detail(detail(task))
    assert model.can_open_folder()

    model.request_open_folder()

    assert opened == [existing]


def test_open_folder_disabled_for_cache_destination() -> None:
    """Given a cache destination, when queried, then Open Folder is disabled."""
    model = _build(TaskCommands(open_folder=lambda path: None))
    task = snapshot(_task_id(), LifecycleState.SUCCEEDED, spec=cache_spec())
    model.apply_detail(detail(task))
    assert not model.can_open_folder()


def test_open_folder_disabled_when_path_missing(tmp_path: Path) -> None:
    """Given a non-existent path, when queried, then Open Folder is disabled."""
    adjusted = single_file_spec().model_copy(
        update={"destination": LocalDirectoryDestination(path=tmp_path / "absent")}
    )
    model = _build(TaskCommands(open_folder=lambda path: None))
    model.apply_detail(
        detail(snapshot(_task_id(), LifecycleState.SUCCEEDED, spec=adjusted))
    )
    assert not model.can_open_folder()


def test_copy_diagnostic_redacts_registered_secret() -> None:
    """Given a registered secret embedded in a repo id, when copying, redacted."""
    registry = SecretRegistry()
    registry.register("hf_sentinel_token")
    model = TaskActionModel(TaskCommands(), registry)
    task = snapshot(
        _task_id(),
        LifecycleState.RUNNING,
        spec=single_file_spec("org/hf_sentinel_token"),
    )
    model.apply_detail(detail(task))

    summary = model.request_copy_diagnostic()

    assert "hf_sentinel_token" not in summary
    assert "REDACTED" in summary or "[REDACTED]" in summary


def test_copy_diagnostic_always_available_for_loaded_task() -> None:
    """Given any loaded task, when queried, then Copy Diagnostic is valid."""
    model = _build()
    for state in _ALL_STATES:
        model.apply_detail(detail(snapshot(_task_id(), state)))
        assert model.can_copy_diagnostic()


def test_copy_diagnostic_empty_before_task() -> None:
    """Given no task, when copying, then the summary is empty."""
    model = TaskActionModel()
    assert model.request_copy_diagnostic() == ""


def test_cancel_disabled_for_terminal_states() -> None:
    """Given terminal states, when queried, then Cancel is never valid."""
    model = _build(TaskCommands(cancel=lambda task_id: None))
    for state in (
        LifecycleState.SUCCEEDED,
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
        LifecycleState.CANCELLING,
    ):
        model.apply_detail(detail(snapshot(_task_id(), state)))
        assert not model.can_cancel(), state
