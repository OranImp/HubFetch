"""Virtualized, sanitized event timeline for the task detail view.

The timeline renders persisted transfer events through a ``QListView`` backed
by a small list model and a custom delegate. Because the delegate paints the
visible rows directly, 10 000-event timelines never create 10 000 widgets;
only the on-screen rows are painted (QListView virtualization). Every row is
sanitized with :class:`Redactor` before it becomes model data, and rows are
appended incrementally when the event stream only grows at the tail.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, override

from PySide6.QtCore import (
    QAbstractListModel,
    QModelIndex,
    QPersistentModelIndex,
    QSize,
    Qt,
)
from PySide6.QtWidgets import (
    QListView,
    QStyledItemDelegate,
    QStyleOptionViewItem,
    QWidget,
)

from hubfetch.domain.events import (
    TaskQueuedEvent,
    TaskTransitionedEvent,
    TransferProgressedEvent,
)
from hubfetch.security.redaction import Redactor
from hubfetch.ui import fonts, tokens

if TYPE_CHECKING:
    from collections.abc import Sequence

    from PySide6.QtGui import QPainter

    from hubfetch.domain.events import PersistedEvent

TEXT_ROLE: Final[int] = Qt.ItemDataRole.UserRole + 1
MAX_TIMELINE_ROWS: Final[int] = 10_000
_ROW_HEIGHT: Final[int] = tokens.CAPTION_LINE + tokens.SPACE_XS


def render_event(event: PersistedEvent) -> str:
    """Render one persisted event as a compact, sanitizable ledger line."""
    stamp = event.occurred_at.strftime("%H:%M:%S")
    if isinstance(event, TaskQueuedEvent):
        return f"{stamp}  queued"
    if isinstance(event, TransferProgressedEvent):
        return f"{stamp}  {event.bytes_done} / {event.bytes_total} B"
    if isinstance(event, TaskTransitionedEvent):
        return f"{stamp}  {event.from_state.value} → {event.to_state.value}"
    # The remaining union member is the recovered event.
    return f"{stamp}  recovered {event.from_state.value} → interrupted"


class _TimelineModel(QAbstractListModel):
    """Holds sanitized timeline rows; appends extend only the tail."""

    def __init__(self) -> None:
        """Start with an empty row buffer."""
        super().__init__()
        self._rows: list[str] = []

    @override
    def rowCount(
        self, parent: QModelIndex | QPersistentModelIndex | None = None
    ) -> int:
        """Return the number of sanitized rows; the timeline has no children."""
        if parent is not None and parent.isValid():
            return 0
        return len(self._rows)

    @override
    def data(
        self,
        index: QModelIndex | QPersistentModelIndex,
        role: int = Qt.ItemDataRole.DisplayRole,
    ) -> object:
        """Expose the sanitized row text through the display and text roles."""
        if not index.isValid() or not (0 <= index.row() < len(self._rows)):
            return None
        if role in (Qt.ItemDataRole.DisplayRole, TEXT_ROLE):
            return self._rows[index.row()]
        return None

    def replace(self, events: Sequence[PersistedEvent]) -> None:
        """Replace all rows after sanitizing every event line."""
        rows = [Redactor().redact_text(render_event(event)) for event in events]
        self.beginResetModel()
        try:
            self._rows = rows[:MAX_TIMELINE_ROWS]
        finally:
            self.endResetModel()

    def append_tail(self, events: Sequence[PersistedEvent]) -> None:
        """Append rows only for events that extend the current tail."""
        if not events:
            return
        known = len(self._rows)
        if known >= MAX_TIMELINE_ROWS:
            return
        tail = [
            Redactor().redact_text(render_event(event))
            for event in events[: MAX_TIMELINE_ROWS - known]
        ]
        first = known
        last = known + len(tail) - 1
        self.beginInsertRows(QModelIndex(), first, last)
        try:
            self._rows.extend(tail)
        finally:
            self.endInsertRows()

    def row_text(self, row: int) -> str:
        """Return the sanitized text at ``row`` for copy operations."""
        return self._rows[row]


class _TimelineDelegate(QStyledItemDelegate):
    """Paints one sanitized row in the technical mono face."""

    def __init__(self, model: _TimelineModel, parent: QWidget | None = None) -> None:
        """Bind the model so painted rows read text without role Any."""
        super().__init__(parent)
        self._model: _TimelineModel = model

    @override
    def paint(
        self,
        painter: QPainter,
        option: QStyleOptionViewItem,
        index: QModelIndex | QPersistentModelIndex,
    ) -> None:
        """Draw the row text directly, so only visible rows are rendered."""
        painter.save()
        try:
            painter.setFont(fonts.mono_font(tokens.CAPTION_SIZE))
            painter.setPen(tokens.INK_COLOR)
            _ = painter.drawText(
                option.rect.adjusted(tokens.SPACE_SM, 0, -tokens.SPACE_SM, 0),
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                self._model.row_text(index.row()),
            )
        finally:
            painter.restore()

    @override
    def sizeHint(
        self,
        option: QStyleOptionViewItem,
        index: QModelIndex | QPersistentModelIndex,
    ) -> QSize:
        """Return the fixed one-line row height for the mono face."""
        _ = option
        _ = index
        return QSize(0, _ROW_HEIGHT)


class TaskTimeline(QWidget):
    """A virtualized sanitized event list with incremental tail appends."""

    def __init__(self, accessible_name: str, parent: QWidget | None = None) -> None:
        """Build the list view, model, and painted delegate."""
        super().__init__(parent)
        self._model: _TimelineModel = _TimelineModel()
        self._list: QListView = QListView(self)
        self._list.setModel(self._model)
        self._list.setItemDelegate(_TimelineDelegate(self._model, self._list))
        self._list.setSelectionMode(QListView.SelectionMode.NoSelection)
        self._list.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._list.setVerticalScrollMode(QListView.ScrollMode.ScrollPerPixel)
        self._list.setAccessibleName(accessible_name)
        self.setAccessibleName(accessible_name)
        self.setAccessibleDescription(
            "Sanitized transfer events; log lines never show raw worker stderr"
        )

    def list_view(self) -> QListView:
        """Expose the underlying list view for scroll/layout assertions."""
        return self._list

    def set_events(self, events: Sequence[PersistedEvent]) -> None:
        """Replace the whole timeline after sanitizing each event."""
        self._model.replace(events)

    def append_events(self, events: Sequence[PersistedEvent]) -> None:
        """Append only the events that extend the current tail."""
        self._model.append_tail(events)

    def row_count(self) -> int:
        """Return how many sanitized rows are currently held."""
        return self._model.rowCount()

    def sanitized_text(self) -> str:
        """Return every sanitized row joined for copy/QA assertions."""
        rows = [self._model.row_text(row) for row in range(self.row_count())]
        return "\n".join(rows)


__all__ = ["MAX_TIMELINE_ROWS", "TaskTimeline", "render_event"]
