"""Task list pane rendering immutable queue snapshots into ledger rows.

Todo 21 exposes queue snapshots as frozen value objects; this pane is the pure
presentation of one snapshot into DESIGN.md task rows. Rows carry the repo id,
kind, lifecycle status icon/text pair, and queue position, with the repo id
middle-elided so long identifiers never widen the list (DESIGN.md 4). The pane
owns exactly one scroll region (DESIGN.md 8.1), keeps exactly one selection,
restores keyboard focus after rebuilds, and never reaches the domain services
directly -- the runtime hands it only immutable snapshots.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final, override

from PySide6.QtCore import QEvent, QObject, Qt, Signal
from PySide6.QtGui import QFont, QKeyEvent
from PySide6.QtWidgets import (
    QFrame,
    QLabel,
    QScrollArea,
    QSizePolicy,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from hubfetch.ui import tokens
from hubfetch.ui.widgets.blocks import EmptyBlock
from hubfetch.ui.widgets.common import semantic_colors
from hubfetch.ui.widgets.task_row import TaskRow, TaskRowSnapshot

if TYPE_CHECKING:
    from hubfetch.application.snapshots import QueueSnapshot, TaskSnapshot
    from hubfetch.domain.ids import TaskId
    from hubfetch.ui.navigation import ShellTexts

__all__ = ["TaskListPane"]


@final
class _RowEventFilter(QObject):
    """Translate one row's pointer/keyboard events into list selection."""

    __slots__: Final = ("_pane",)
    _pane: TaskListPane

    def __init__(self, pane: TaskListPane) -> None:
        """Bind the filter to the pane that owns the rows."""
        super().__init__(pane)
        self._pane = pane

    @override
    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        """Select on click; move selection with Up/Down; accept Return/Space."""
        if event.type() == QEvent.Type.MouseButtonRelease:
            task_id = self._pane.task_id_for(watched)
            if task_id is not None:
                self._pane.set_selected(task_id)
            return True
        if event.type() == QEvent.Type.KeyPress and isinstance(event, QKeyEvent):
            key = event.key()
            if key == Qt.Key.Key_Down:
                self._pane.move_selection(1)
                return True
            if key == Qt.Key.Key_Up:
                self._pane.move_selection(-1)
                return True
            if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space):
                task_id = self._pane.task_id_for(watched)
                if task_id is not None:
                    self._pane.set_selected(task_id)
                return True
        return False


def _row_snapshot(task: TaskSnapshot, texts: ShellTexts) -> TaskRowSnapshot:
    """Map one immutable snapshot into the values one row renders."""
    return TaskRowSnapshot(
        repo_id=task.spec.repository.repo_id,
        kind_label=texts.kind_text(task.spec.kind),
        status=texts.state_severity(task.state),
        status_text=texts.state_text(task.state),
        fraction=None,
        caption=texts.queue_caption(task.position),
    )


@final
class TaskListPane(QFrame):
    """A fixed-width queue list with one scroll owner and one selection."""

    selection_changed = Signal(str)
    """Emitted with the task id whenever a row becomes the selection."""

    __slots__: Final = (
        "_container",
        "_empty",
        "_order",
        "_row_filter",
        "_rows",
        "_rows_layout",
        "_scroll",
        "_selected",
        "_stack",
        "_tasks",
        "_texts",
    )
    _texts: ShellTexts
    _selected: TaskId | None
    _tasks: tuple[TaskSnapshot, ...]
    _rows: dict[TaskId, TaskRow]
    _order: tuple[TaskId, ...]
    _scroll: QScrollArea
    _container: QWidget
    _rows_layout: QVBoxLayout
    _empty: EmptyBlock
    _stack: QStackedWidget
    _row_filter: _RowEventFilter

    def __init__(self, texts: ShellTexts) -> None:
        """Compose the header, the single scroll owner, and the empty block."""
        super().__init__()
        self._texts = texts
        self._selected = None
        self._tasks = ()
        self._rows = {}
        self._order = ()
        colors = semantic_colors(self.palette())
        self.setFrameShape(QFrame.Shape.StyledPanel)
        sheet = (
            "QFrame { background-color: "
            + colors.surface
            + "; border: none; border-right: 1px solid "
            + colors.border
            + "; }"
        )
        self.setStyleSheet(sheet)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_MD)
        header = QLabel(texts.tasks_header)
        font = header.font()
        font.setWeight(QFont.Weight.DemiBold)
        header.setFont(font)
        layout.addWidget(header)
        self._scroll = QScrollArea(self)
        self._scroll.setWidgetResizable(True)
        self._scroll.setFrameShape(QFrame.Shape.NoFrame)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        # A scroll owner must never force the shell wider than its viewport;
        # the container's sizeHint alone drives scrolling (DESIGN 8.1).
        self._scroll.setMinimumSize(0, 0)
        self._container = QWidget()
        self._rows_layout = QVBoxLayout(self._container)
        self._rows_layout.setContentsMargins(0, 0, 0, 0)
        self._rows_layout.setSpacing(tokens.SPACE_SM)
        self._rows_layout.addStretch(1)
        self._scroll.setWidget(self._container)
        self._empty = EmptyBlock(texts.tasks_empty_title, texts.tasks_empty_description)
        self._stack = QStackedWidget(self)
        self._stack.addWidget(self._scroll)
        self._stack.addWidget(self._empty)
        layout.addWidget(self._stack, stretch=1)
        self._row_filter = _RowEventFilter(self)
        self.setAccessibleName(texts.tasks_header)

    def set_snapshot(self, snapshot: QueueSnapshot) -> None:
        """Rebuild rows from an immutable snapshot, preserving the selection."""
        self._tasks = snapshot.tasks
        ids = tuple(task.task_id for task in snapshot.tasks)
        self._order = ids
        if self._selected is not None and self._selected not in ids:
            self._selected = None
        self._rebuild_rows()
        self._sync_empty()

    def selected_task_id(self) -> TaskId | None:
        """Return the currently selected task id, if any."""
        return self._selected

    def set_selected(self, task_id: TaskId | None) -> None:
        """Select one row (or clear selection) and announce real changes."""
        if task_id is not None and task_id == self._selected:
            return
        self._selected = task_id
        for existing_id, row in self._rows.items():
            row.setSelection(existing_id == task_id)
        if task_id is not None:
            self.selection_changed.emit(task_id)

    def task_rows(self) -> tuple[TaskRow, ...]:
        """Return the rendered rows in snapshot order."""
        rows: list[TaskRow] = []
        for task_id in self._order:
            row = self._rows.get(task_id)
            if row is not None:
                rows.append(row)
        return tuple(rows)

    def task_ids(self) -> tuple[TaskId, ...]:
        """Return the task ids in snapshot order."""
        return self._order

    def has_tasks(self) -> bool:
        """Return whether any snapshot row is present."""
        return bool(self._tasks)

    def is_empty_shown(self) -> bool:
        """Return whether the empty block currently owns the pane."""
        return self._stack.currentIndex() == 1

    def scroll_area(self) -> QScrollArea:
        """Expose the single scroll owner for geometry assertions."""
        return self._scroll

    def focus_selection(self) -> None:
        """Restore keyboard focus to the selected row, else the first row."""
        target: TaskRow | None = None
        if self._selected is not None:
            target = self._rows.get(self._selected)
        if target is None and self._rows:
            target = next(iter(self._rows.values()))
        if target is not None:
            target.setFocus(Qt.FocusReason.TabFocusReason)
            self._scroll.ensureWidgetVisible(target)

    def task_id_for(self, widget: QObject) -> TaskId | None:
        """Return the task id of one row widget, if it is a rendered row."""
        for task_id, row in self._rows.items():
            if row is widget:
                return task_id
        return None

    def move_selection(self, direction: int) -> None:
        """Move the selection one row in ``direction`` within snapshot order."""
        ids = self._order
        if not ids:
            return
        if self._selected is None or self._selected not in ids:
            index = 0 if direction > 0 else len(ids) - 1
        else:
            current = ids.index(self._selected)
            index = min(max(current + direction, 0), len(ids) - 1)
        self.set_selected(ids[index])

    def _rebuild_rows(self) -> None:
        """Replace every rendered row with fresh rows over the new snapshot."""
        while self._rows_layout.count():
            item = self._rows_layout.takeAt(0)
            if item is not None:
                widget = item.widget()
                if widget is not None:
                    widget.deleteLater()
        self._rows.clear()
        for task in self._tasks:
            row = TaskRow()
            row.set_snapshot(_row_snapshot(task, self._texts))
            row.setSelection(task.task_id == self._selected)
            row.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
            accessible = (
                self._texts.kind_text(task.spec.kind)
                + " "
                + task.spec.repository.repo_id
            )
            row.setAccessibleName(accessible)
            row.installEventFilter(self._row_filter)
            # The repo label's sizeHint tracks its elided text, which would force
            # the container wider than the viewport; Ignored lets the label fill
            # the row and elide instead of driving horizontal scroll (DESIGN 8.1).
            row.repo_label().setSizePolicy(
                QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred
            )
            self._rows[task.task_id] = row
            self._rows_layout.addWidget(row)
        self._rows_layout.addStretch(1)
        self._container.adjustSize()

    def _sync_empty(self) -> None:
        """Swap the scroll owner for the empty block when the queue is empty."""
        self._stack.setCurrentIndex(1 if self._tasks == () else 0)
