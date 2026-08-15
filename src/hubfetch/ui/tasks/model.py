"""Incrementally updated task queue model for the transfer ledger.

Binds immutable :class:`QueueSnapshot` values into a ``QAbstractListModel``
without ever calling ``modelReset``: applying a new snapshot computes the
minimal row insertion/removal/dataChanged signal set so stable list geometry
(scroll position, selected row control) is preserved while rows mutate. The
selected task is tracked by ``task_id`` and survives re-renders; it is cleared
only when the underlying task is removed from the queue.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, override

from PySide6.QtCore import (
    QAbstractListModel,
    QModelIndex,
    QObject,
    QPersistentModelIndex,
    Qt,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from hubfetch.application.snapshots import QueueSnapshot, TaskSnapshot
    from hubfetch.domain.ids import TaskId

TASK_ID_ROLE: Final[int] = Qt.ItemDataRole.UserRole + 1
KIND_ROLE: Final[int] = Qt.ItemDataRole.UserRole + 2
STATE_ROLE: Final[int] = Qt.ItemDataRole.UserRole + 3
POSITION_ROLE: Final[int] = Qt.ItemDataRole.UserRole + 4
REPO_ROLE: Final[int] = Qt.ItemDataRole.UserRole + 5


class TaskListModel(QAbstractListModel):
    """A FIFO queue view that updates by row diff, never by full reset."""

    def __init__(self, parent: QObject | None = None) -> None:
        """Start with an empty, unselected queue."""
        super().__init__(parent)
        self._tasks: tuple[TaskSnapshot, ...] = ()
        self._selected: TaskId | None = None

    # -- Qt model interface -------------------------------------------------

    @override
    def rowCount(
        self, parent: QModelIndex | QPersistentModelIndex | None = None
    ) -> int:
        """Return the number of queued tasks; the queue root has no children."""
        if parent is not None and parent.isValid():
            return 0
        return len(self._tasks)

    @override
    def data(
        self,
        index: QModelIndex | QPersistentModelIndex,
        role: int = Qt.ItemDataRole.DisplayRole,
    ) -> object:
        """Expose task identity, state, and position through typed roles."""
        if not index.isValid() or not (0 <= index.row() < len(self._tasks)):
            return None
        task = self._tasks[index.row()]
        values = {
            TASK_ID_ROLE: task.task_id,
            KIND_ROLE: task.spec.kind,
            STATE_ROLE: task.state,
            POSITION_ROLE: task.position,
            REPO_ROLE: task.spec.repository.repo_id,
            Qt.ItemDataRole.DisplayRole: task.spec.repository.repo_id,
        }
        return values.get(role)

    # -- snapshot application (the incremental contract) --------------------

    def apply_snapshot(self, snapshot: QueueSnapshot) -> None:
        """Diff ``snapshot`` against the current rows and emit minimal signals.

        Rows whose task ids persist are kept in place (stable geometry);
        removed ids use ``beginRemoveRows``, new ids ``beginInsertRows``, and
        retained rows whose state/position changed use ``dataChanged``.
        """
        new_tasks = snapshot.tasks
        old_by_id = {task.task_id: task for task in self._tasks}
        new_by_id = {task.task_id: task for task in new_tasks}
        if self._selected is not None and self._selected not in new_by_id:
            self._selected = None

        self._remove_vanished(old_by_id, new_by_id)
        self._insert_new(new_tasks, old_by_id)
        self._touch_changed(new_tasks, old_by_id)

    def _remove_vanished(
        self,
        old_by_id: dict[TaskId, TaskSnapshot],
        new_by_id: dict[TaskId, TaskSnapshot],
    ) -> None:
        """Emit one remove signal per task that left the queue (reverse order)."""
        for row in range(len(self._tasks) - 1, -1, -1):
            task_id = self._tasks[row].task_id
            if task_id in new_by_id:
                continue
            del old_by_id[task_id]
            self.beginRemoveRows(QModelIndex(), row, row)
            self._tasks = self._tasks[:row] + self._tasks[row + 1 :]
            self.endRemoveRows()

    def _insert_new(
        self,
        new_tasks: Sequence[TaskSnapshot],
        old_by_id: dict[TaskId, TaskSnapshot],
    ) -> None:
        """Insert rows for tasks that appeared, preserving snapshot order."""
        for index, task in enumerate(new_tasks):
            if task.task_id in old_by_id:
                continue
            self.beginInsertRows(QModelIndex(), index, index)
            self._tasks = (*self._tasks[:index], task, *self._tasks[index:])
            self.endInsertRows()

    def _touch_changed(
        self,
        new_tasks: Sequence[TaskSnapshot],
        old_by_id: dict[TaskId, TaskSnapshot],
    ) -> None:
        """Emit dataChanged for retained rows whose state or position moved."""
        for row, task in enumerate(new_tasks):
            previous = old_by_id.get(task.task_id)
            if previous is None:
                continue
            if previous.state != task.state or previous.position != task.position:
                top_left = self.index(row, 0)
                bottom_right = self.index(row, 0)
                self._tasks = (*self._tasks[:row], task, *self._tasks[row + 1 :])
                self.dataChanged.emit(top_left, bottom_right)

    # -- selection (persists by task id, not by row) ------------------------

    def selected_task_id(self) -> TaskId | None:
        """Return the currently selected task id, if any."""
        return self._selected

    def set_selected(self, task_id: TaskId | None) -> None:
        """Select by task id; the value survives later incremental updates."""
        if task_id is not None and task_id not in {
            task.task_id for task in self._tasks
        }:
            message = f"unknown task id: {task_id}"
            raise ValueError(message)
        self._selected = task_id

    def task_at(self, row: int) -> TaskSnapshot | None:
        """Return the snapshot at ``row`` or None when out of range."""
        if not (0 <= row < len(self._tasks)):
            return None
        return self._tasks[row]

    def row_of(self, task_id: TaskId) -> int | None:
        """Return the current row for ``task_id`` or None when absent."""
        for row, task in enumerate(self._tasks):
            if task.task_id == task_id:
                return row
        return None


__all__ = [
    "KIND_ROLE",
    "POSITION_ROLE",
    "REPO_ROLE",
    "STATE_ROLE",
    "TASK_ID_ROLE",
    "TaskListModel",
]
