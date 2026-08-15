"""Given/When/Then contracts for the task detail view and timeline.

Todo 26: the detail view must render identity/spec/position/attempt/destination
from an immutable snapshot, expose stage status textually (never color-only),
derive numeric/byte/speed progress from the two latest progress events,
sanitize every timeline row, virtualize long timelines, and keep every command
routed through the action model.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QWidget

from hubfetch.domain.ids import parse_task_id
from hubfetch.domain.lifecycle import LifecycleState, TransferStage
from hubfetch.security.redaction import SecretRegistry
from hubfetch.ui.tasks.actions import TaskActionModel, TaskCommands
from hubfetch.ui.tasks.detail import TaskDetailView
from hubfetch.ui.tasks.reading import format_bytes
from hubfetch.ui.tasks.timeline import MAX_TIMELINE_ROWS, TaskTimeline, render_event

from .helpers import (
    cache_spec,
    detail,
    git_spec,
    progress_event,
    queued_event,
    single_file_spec,
    snapshot,
    texts,
)

if TYPE_CHECKING:
    from pytestqt.qtbot import QtBot

    from hubfetch.domain.ids import TaskId


def _view() -> TaskDetailView:
    """Build a fresh detail view with a no-op action seam."""
    actions = TaskActionModel(TaskCommands())
    return TaskDetailView(texts(), actions)


def _view_with_retry() -> TaskDetailView:
    """Build a detail view whose Retry seam is wired (no-op)."""
    actions = TaskActionModel(TaskCommands(retry=lambda task_id: None))
    return TaskDetailView(texts(), actions)


def _task_id() -> TaskId:
    """Return one stable task id."""
    return parse_task_id("task-1")


def test_render_identity_fields() -> None:
    """Given a running snapshot, when applied, then identity fields render."""
    view = _view()
    task = snapshot(
        _task_id(),
        LifecycleState.RUNNING,
        spec=single_file_spec("org/fancy-model"),
        position=3,
    )
    events = (
        queued_event(_task_id()),
        progress_event(_task_id(), 500, 1000),
    )
    view.apply_detail(detail(task, events))

    assert view.state_text() == "传输中"
    assert view.rail().accessible_stage_texts() != []
    assert view.rail().active_segment() is not None
    assert view.progress_bar().bar_value_percent() == 50


def test_stage_accessibility_reports_every_stage() -> None:
    """Given a running task, when queried, then every stage has text+status."""
    view = _view()
    task = snapshot(_task_id(), LifecycleState.RUNNING)
    events = (progress_event(_task_id(), 0, 100, stage=TransferStage.TRANSFER),)
    view.apply_detail(detail(task, events))

    stage_texts = view.rail().accessible_stage_texts()

    assert len(stage_texts) == 6
    assert any("传输 · 进行中" in entry for entry in stage_texts)


def test_queued_state_has_no_active_stage() -> None:
    """Given a queued task, when applied, then the rail shows no active stage."""
    view = _view()
    view.apply_detail(detail(snapshot(_task_id(), LifecycleState.QUEUED)))
    assert view.rail().active_segment() is None


def test_succeeded_state_marks_every_stage_done() -> None:
    """Given a succeeded task, when applied, then all six stages are done."""
    view = _view()
    view.apply_detail(detail(snapshot(_task_id(), LifecycleState.SUCCEEDED)))
    assert view.rail().active_segment() is None
    assert "完成" in " · ".join(view.rail().accessible_stage_texts())


def test_failed_state_marks_failing_stage_failed() -> None:
    """Given a failed task, when applied, then the failing stage shows failed."""
    view = _view()
    task = snapshot(_task_id(), LifecycleState.FAILED)
    events = (progress_event(_task_id(), 10, 100, stage=TransferStage.TRANSFER),)
    view.apply_detail(detail(task, events))
    stage_texts = view.rail().accessible_stage_texts()
    assert any("传输 · 失败" in entry for entry in stage_texts)


def test_speed_derived_from_two_latest_events() -> None:
    """Given two progress events, when applied, then speed appears in caption."""
    view = _view()
    task = snapshot(_task_id(), LifecycleState.RUNNING)
    events = (
        progress_event(_task_id(), 0, 1000, delta_seconds=1),
        progress_event(_task_id(), 500, 1000, delta_seconds=2),
    )
    view.apply_detail(detail(task, events))
    caption = view.progress_bar().caption_text()
    assert "50%" in caption
    assert "500 B" in caption


def test_destination_shows_local_path() -> None:
    """Given a local destination, when applied, then the path is shown."""
    view = _view()
    task = snapshot(_task_id(), LifecycleState.QUEUED, spec=single_file_spec())
    view.apply_detail(detail(task))
    assert "E:\\downloads" in view.destination_text()


def test_destination_shows_git_path() -> None:
    """Given a Git destination, when applied, then the path is shown."""
    view = _view()
    task = snapshot(
        _task_id(), LifecycleState.QUEUED, spec=git_spec("E:\\clone-target")
    )
    view.apply_detail(detail(task))
    assert "E:\\clone-target" in view.destination_text()


def test_destination_shows_cache_label() -> None:
    """Given a cache destination, when applied, then the cache label is shown."""
    view = _view()
    task = snapshot(_task_id(), LifecycleState.QUEUED, spec=cache_spec())
    view.apply_detail(detail(task))
    assert "缓存" in view.destination_text()


def test_recovery_shown_only_for_retryable_states() -> None:
    """Given states, when applied, then recovery matches retryability."""
    view = _view()
    retryable = (
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
    )
    for state in LifecycleState:
        view.apply_detail(detail(snapshot(_task_id(), state)))
        assert view.recovery().isHidden() == (state not in retryable), state


def test_timeline_sanitizes_registered_secret(qtbot: QtBot) -> None:
    """Given a secret-bearing event, when applied, then it never renders."""
    _ = qtbot
    registry = SecretRegistry()
    registry.register("hf_sentinel_token")
    actions = TaskActionModel(TaskCommands(), registry)
    view = TaskDetailView(texts(), actions)
    task = snapshot(
        _task_id(),
        LifecycleState.RUNNING,
        spec=single_file_spec("org/hf_sentinel_token"),
    )
    events = (queued_event(_task_id()),)
    view.apply_detail(detail(task, events))
    rendered = view.timeline().sanitized_text()
    assert "hf_sentinel_token" not in rendered


def test_timeline_append_extends_tail_only(qtbot: QtBot) -> None:
    """Given a timeline, when events grow, then only the tail is appended."""
    _ = qtbot
    timeline = TaskTimeline("timeline")
    first = (queued_event(_task_id()),)
    timeline.set_events(first)
    assert timeline.row_count() == 1

    second = (progress_event(_task_id(), 10, 100),)
    timeline.append_events(second)

    assert timeline.row_count() == 2
    assert "queued" in timeline.sanitized_text()


def test_timeline_virtualizes_ten_thousand_events(qtbot: QtBot) -> None:
    """Given 10k events, when rendered, then widget count stays bounded."""
    _ = qtbot
    timeline = TaskTimeline("timeline")
    events = tuple(
        progress_event(_task_id(), index, 10000, delta_seconds=index + 1)
        for index in range(MAX_TIMELINE_ROWS)
    )
    timeline.set_events(events)
    assert timeline.row_count() == MAX_TIMELINE_ROWS
    view = timeline.list_view()
    view.resize(400, 300)
    widget_count = len(
        [child for child in view.findChildren(QWidget) if not child.isHidden()]
    )
    assert widget_count < 50


def test_format_bytes_scales() -> None:
    """Given byte counts, when formatted, then units scale correctly."""
    assert format_bytes(0) == "0 B"
    assert format_bytes(1023) == "1023 B"
    assert format_bytes(2048) == "2.0 KiB"
    assert format_bytes(1024 * 1024 * 5) == "5.0 MiB"
    assert format_bytes(1024**4) == "1.0 TiB"


def test_render_event_has_kind_text() -> None:
    """Given event variants, when rendered, then each has recognizable text."""
    assert "queued" in render_event(queued_event(_task_id()))
    progressed = progress_event(_task_id(), 10, 100)
    assert "10" in render_event(progressed)
    assert "100" in render_event(progressed)


def test_cancel_button_routes_through_action_model(qtbot: QtBot) -> None:
    """Given a running task, when Cancel clicked, then only the seam fires."""
    _ = qtbot
    calls: list[TaskId] = []

    def record_cancel(task_id: TaskId) -> None:
        calls.append(task_id)

    actions = TaskActionModel(TaskCommands(cancel=record_cancel))
    view = TaskDetailView(texts(), actions)
    view.apply_detail(detail(snapshot(_task_id(), LifecycleState.RUNNING)))
    assert view.cancel_button().isEnabled()

    view.cancel_button().click()

    assert calls == [_task_id()]
    assert view.cancel_button().text() == "正在取消…"


def test_retry_button_disabled_for_non_retryable() -> None:
    """Given a running task, when applied, then Retry is disabled."""
    view = _view()
    view.apply_detail(detail(snapshot(_task_id(), LifecycleState.RUNNING)))
    assert not view.retry_button().isEnabled()


def test_retry_button_enabled_for_failed() -> None:
    """Given a failed task, when applied, then Retry is enabled."""
    view = _view_with_retry()
    view.apply_detail(detail(snapshot(_task_id(), LifecycleState.FAILED)))
    assert view.retry_button().isEnabled()


def test_open_folder_disabled_for_cache() -> None:
    """Given a cache task, when applied, then Open Folder is disabled."""
    view = _view()
    view.apply_detail(
        detail(snapshot(_task_id(), LifecycleState.SUCCEEDED, spec=cache_spec()))
    )
    assert not view.open_folder_button().isEnabled()


def test_stage_status_is_never_color_only() -> None:
    """Given a running task, when queried, then the active stage has a glyph."""
    view = _view()
    view.apply_detail(detail(snapshot(_task_id(), LifecycleState.RUNNING)))
    icon = view.rail().stage_icon_name(TransferStage.TRANSFER)
    assert icon is not None
    # Every accessible stage text names both the stage and its status, so the
    # rail is legible without color (DESIGN.md 6.3).
    for entry in view.rail().accessible_stage_texts():
        assert "·" in entry


def test_focus_policy_is_mouse_independent(qtbot: QtBot) -> None:
    """Given the view, when queried, then buttons are keyboard reachable."""
    _ = qtbot
    view = _view()
    assert view.retry_button().focusPolicy() != Qt.FocusPolicy.NoFocus


def test_accessible_names_present() -> None:
    """Given the view, when queried, then controls carry accessible names."""
    view = _view()
    assert view.timeline().accessibleName()
    assert view.cancel_button().accessibleName()
