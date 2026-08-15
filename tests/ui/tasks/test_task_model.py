"""Given/When/Then contracts for the incrementally updated task list model.

Todo 26: the queue model must bind immutable queue snapshots, apply updates as
a row diff (never ``modelReset``), preserve stable geometry, keep selection by
task id across updates, and clear selection only when the task is removed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from PySide6.QtCore import QModelIndex, Qt

from hubfetch.domain.ids import parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.ui.tasks.model import (
    KIND_ROLE,
    POSITION_ROLE,
    REPO_ROLE,
    STATE_ROLE,
    TASK_ID_ROLE,
    TaskListModel,
)

from .helpers import queue, snapshot

if TYPE_CHECKING:
    from collections.abc import Callable

    from pytestqt.qtbot import QtBot

    from hubfetch.domain.ids import TaskId


def _task_ids(model: TaskListModel) -> list[TaskId]:
    """Collect every task id exposed by the model in row order."""
    ids: list[TaskId] = []
    for row in range(model.rowCount()):
        value = model.data(model.index(row, 0), TASK_ID_ROLE)
        if isinstance(value, str):
            ids.append(parse_task_id(value))
    return ids


def _track_rows(
    model: TaskListModel, signal: object
) -> Callable[[], list[tuple[int, int]]]:
    """Record each (start, end) pair emitted by a Qt model signal."""
    captured: list[tuple[int, int]] = []

    def on_signal(
        parent: QModelIndex,
        start: int,
        end: int,
        captured: list[tuple[int, int]] = captured,
    ) -> None:
        _ = parent
        captured.append((start, end))

    targets = {
        "rows_inserted": model.rowsInserted,
        "rows_removed": model.rowsRemoved,
    }
    picked: object | None = None
    for name, target in targets.items():
        if signal is target:
            picked = name
            break
    if picked == "rows_inserted":
        _ = model.rowsInserted.connect(on_signal)
    elif picked == "rows_removed":
        _ = model.rowsRemoved.connect(on_signal)
    return lambda: list(captured)


def test_fifo_ordering_initial_snapshot() -> None:
    """Given three queued tasks, when applied, then rows expose FIFO order."""
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    third = parse_task_id("task-3")
    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
            snapshot(third, LifecycleState.QUEUED, position=2),
        )
    )
    assert _task_ids(model) == [first, second, third]
    assert model.data(model.index(1, 0), POSITION_ROLE) == 1
    assert model.data(model.index(1, 0), STATE_ROLE) is LifecycleState.QUEUED
    assert model.data(model.index(1, 0), KIND_ROLE) == "single_file"
    assert model.data(model.index(1, 0), REPO_ROLE) == "org/model"


def test_apply_snapshot_never_resets(qtbot: QtBot) -> None:
    """Given a running model, when a snapshot updates, then no modelReset fires."""
    _ = qtbot
    model = TaskListModel()
    task_id = parse_task_id("task-1")
    model.apply_snapshot(queue(snapshot(task_id, LifecycleState.RUNNING, position=0)))
    resets: list[int] = []
    _ = model.modelReset.connect(lambda: resets.append(1))

    model.apply_snapshot(queue(snapshot(task_id, LifecycleState.SUCCEEDED, position=0)))

    assert resets == []


def test_incremental_update_inserts_only_new_rows(qtbot: QtBot) -> None:
    """Given one task present, when a second appears, then only one insert emits."""
    _ = qtbot
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    model.apply_snapshot(queue(snapshot(first, LifecycleState.QUEUED, position=0)))
    insert_track = _track_rows(model, model.rowsInserted)

    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )

    assert insert_track() == [(1, 1)]
    assert _task_ids(model) == [first, second]


def test_incremental_update_removes_only_gone_rows(qtbot: QtBot) -> None:
    """Given two tasks, when one leaves the queue, then only its row is removed."""
    _ = qtbot
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )
    remove_track = _track_rows(model, model.rowsRemoved)

    model.apply_snapshot(queue(snapshot(second, LifecycleState.QUEUED, position=0)))

    assert remove_track() == [(0, 0)]
    assert _task_ids(model) == [second]


def test_data_changed_only_for_mutated_row(qtbot: QtBot) -> None:
    """Given two rows, when only one changes state, then dataChanged hits one."""
    _ = qtbot
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )
    changed_rows: list[int] = []

    def on_data_changed(
        top_left: QModelIndex,
        bottom_right: QModelIndex,
        roles: object = None,
    ) -> None:
        _ = bottom_right
        _ = roles
        changed_rows.append(top_left.row())

    _ = model.dataChanged.connect(on_data_changed)

    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.RUNNING, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )

    assert changed_rows == [0]
    assert model.data(model.index(0, 0), STATE_ROLE) is LifecycleState.RUNNING
    assert model.data(model.index(1, 0), STATE_ROLE) is LifecycleState.QUEUED


def test_selection_persists_across_incremental_updates() -> None:
    """Given a selected task, when rows update, then selection survives."""
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )
    model.set_selected(first)

    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.RUNNING, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )

    assert model.selected_task_id() == first


def test_selection_cleared_only_when_task_removed() -> None:
    """Given the selected task leaves the queue, when updating, then it clears."""
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )
    model.set_selected(first)

    model.apply_snapshot(queue(snapshot(second, LifecycleState.QUEUED, position=0)))

    assert model.selected_task_id() is None


def test_set_selected_rejects_unknown_task() -> None:
    """Given a task id that is not in the queue, when selecting, then it raises."""
    model = TaskListModel()
    model.apply_snapshot(
        queue(snapshot(parse_task_id("task-1"), LifecycleState.QUEUED))
    )
    with pytest.raises(ValueError, match="unknown task id"):
        model.set_selected(parse_task_id("task-2"))


def test_row_of_and_task_at_follow_updates() -> None:
    """Given updates, when queried, then row_of/task_at stay consistent."""
    model = TaskListModel()
    first = parse_task_id("task-1")
    second = parse_task_id("task-2")
    model.apply_snapshot(
        queue(
            snapshot(first, LifecycleState.QUEUED, position=0),
            snapshot(second, LifecycleState.QUEUED, position=1),
        )
    )
    model.apply_snapshot(queue(snapshot(second, LifecycleState.RUNNING, position=0)))

    assert model.row_of(second) == 0
    assert model.row_of(first) is None
    assert model.task_at(0) is not None
    assert model.task_at(5) is None


def test_display_role_is_repo_id() -> None:
    """Given a row, when read as DisplayRole, then it returns the repo id."""
    model = TaskListModel()
    model.apply_snapshot(
        queue(snapshot(parse_task_id("task-1"), LifecycleState.QUEUED))
    )
    result = model.data(model.index(0, 0), Qt.ItemDataRole.DisplayRole)
    assert isinstance(result, str)
    assert result == "org/model"
