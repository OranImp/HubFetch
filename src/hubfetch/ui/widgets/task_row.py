"""Task row: a dense ledger row summarizing one transfer task.

A task row packs the repo identity, kind, lifecycle status, progress, and a
caption into a fixed-height surface (DESIGN.md 5.3 list rhythm). The repo id is
middle-elided so long identifiers never widen the row or force horizontal
scrolling (DESIGN.md 4), and the status is rendered as an icon/text pair so it
is never color-only. Selection is exposed to keyboard tests and styling alike.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from PySide6.QtGui import QPalette
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QVBoxLayout

from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.labels import CaptionLabel, ElidedLabel
from hubfetch.ui.widgets.progress import TransferProgressBar
from hubfetch.ui.widgets.status import StatusPair, StatusSeverity

TASK_ROW_HEIGHT: Final[int] = tokens.TASK_ROW_HEIGHT
"""Fixed row height contract traced to DESIGN.md list rhythm."""

_ROW_SHEET: Final[str] = (
    "QFrame {{ border: 1px solid {border};"
    " border-radius: {radius}px;"
    " background-color: {background}; }}"
)


@dataclass(frozen=True, slots=True)
class TaskRowSnapshot:
    """Immutable view-model values needed to render one task row."""

    repo_id: str
    kind_label: str
    status: StatusSeverity
    status_text: str
    fraction: float | None
    caption: str


class TaskRow(QFrame):
    """A fixed-height row rendering a task snapshot with elided repo id."""

    def __init__(self) -> None:
        """Build the empty row skeleton; call :meth:`set_snapshot` to fill it."""
        super().__init__()
        self._selected: bool = False
        self._repo_label: ElidedLabel = ElidedLabel("")
        self._kind_label: QLabel = QLabel()
        self._status: StatusPair = StatusPair(StatusSeverity.INFO, "")
        self._caption: CaptionLabel = CaptionLabel("")
        self._progress: TransferProgressBar = TransferProgressBar("进度")
        self.setFixedHeight(TASK_ROW_HEIGHT)
        self.setFrameShape(QFrame.Shape.StyledPanel)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_SM, tokens.SPACE_XS, tokens.SPACE_SM, tokens.SPACE_XS
        )
        layout.setSpacing(tokens.SPACE_XS)
        self._top_layout: QHBoxLayout = QHBoxLayout()
        self._top_layout.setSpacing(tokens.SPACE_SM)
        self._kind_label.setPixmap(
            icons.icon(
                icons.IconName.DOWNLOAD,
                self.palette().text().color(),
                tokens.ICON_INLINE,
            ).pixmap(tokens.ICON_INLINE, tokens.ICON_INLINE)
        )
        self._top_layout.addWidget(self._kind_label)
        self._top_layout.addWidget(self._repo_label, stretch=1)
        self._top_layout.addWidget(self._status)
        layout.addLayout(self._top_layout)
        self._bottom_layout: QHBoxLayout = QHBoxLayout()
        self._bottom_layout.setSpacing(tokens.SPACE_SM)
        self._bottom_layout.addWidget(self._caption, stretch=1)
        self._bottom_layout.addWidget(self._progress)
        layout.addLayout(self._bottom_layout)
        self._progress.hide()
        self._apply_border(None)
        self.setAccessibleName("任务行")

    def set_snapshot(self, snapshot: TaskRowSnapshot) -> None:
        """Populate the row from an immutable snapshot."""
        self._repo_label.setText(snapshot.repo_id)
        self._repo_label.setAccessibleName(snapshot.repo_id)
        self._caption.setText(snapshot.caption)
        self._replace_status(snapshot.status, snapshot.status_text)
        if snapshot.fraction is None:
            self._progress.hide()
        else:
            self._progress.set_progress(snapshot.fraction, "")
            self._progress.show()
        self.setAccessibleName(f"{snapshot.kind_label} {snapshot.repo_id}")

    def repo_label(self) -> ElidedLabel:
        """Expose the elided repo label for geometry assertions."""
        return self._repo_label

    def setSelection(self, selected: bool) -> None:  # noqa: N802 - mirrors Qt naming
        """Mark the row selected or not and restyle its border.

        The selected border derives from the palette Highlight role, which is
        the Action Blue in every theme (DESIGN.md 9), so selection emphasis
        stays theme-consistent without hardcoding the token here.
        """
        self._selected = selected
        if selected:
            border = self.palette().color(QPalette.ColorRole.Highlight).name()
        else:
            border = None
        self._apply_border(border)

    def isSelected(self) -> bool:  # noqa: N802 - mirrors Qt naming
        """Return whether the row is selected."""
        return self._selected

    def _replace_status(self, severity: StatusSeverity, text: str) -> None:
        self._top_layout.removeWidget(self._status)
        self._status.deleteLater()
        self._status = StatusPair(severity, text)
        self._top_layout.addWidget(self._status)

    def _apply_border(self, color: str | None) -> None:
        palette_colors = common.semantic_colors(self.palette())
        border = color if color is not None else palette_colors.border
        self.setStyleSheet(
            _ROW_SHEET.format(
                border=border,
                radius=tokens.RADIUS_CONTROL,
                background=palette_colors.surface,
            )
        )


__all__ = ["TASK_ROW_HEIGHT", "TaskRow", "TaskRowSnapshot"]
