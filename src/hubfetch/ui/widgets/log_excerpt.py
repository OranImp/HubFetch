"""Read-only log excerpt rendered in the bundled mono font.

Workers emit sanitized diagnostic lines (DESIGN.md security boundary) that the
task detail surfaces as a scrollable excerpt. The excerpt is read-only, uses
the technical data font so paths and revisions align, wraps at the widget width
so long URLs never create horizontal scrolling (DESIGN.md 4), and is bounded by
a maximum height so a log burst cannot crowd out the rest of the pane.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from PySide6.QtWidgets import QPlainTextEdit, QVBoxLayout, QWidget

from hubfetch.ui import fonts, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.labels import CaptionLabel

if TYPE_CHECKING:
    from collections.abc import Sequence

_EDITOR_SHEET: Final[str] = (
    "QPlainTextEdit {{ background-color: {background};"
    " color: {color};"
    " border: 1px solid {border};"
    " border-radius: {radius}px;"
    " padding: {padding}px; }}"
)


class LogExcerpt(QWidget):
    """A bounded read-only mono-font log view."""

    MAX_HEIGHT: Final[int] = tokens.SPACE_XXL * 5
    """Maximum widget height so logs never dominate the detail pane."""

    def __init__(self, accessible_name: str) -> None:
        """Build the labeled read-only editor at the bounded height."""
        super().__init__()
        self._editor: QPlainTextEdit = QPlainTextEdit()
        self._editor.setReadOnly(True)
        self._editor.setFont(fonts.mono_font(tokens.CAPTION_SIZE))
        self._editor.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
        self._editor.setAccessibleName(accessible_name)
        self.setAccessibleName(accessible_name)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_XS)
        layout.addWidget(CaptionLabel(accessible_name))
        layout.addWidget(self._editor, stretch=1)
        self.setMaximumHeight(LogExcerpt.MAX_HEIGHT)
        self._apply_editor_sheet()

    def editor(self) -> QPlainTextEdit:
        """Expose the underlying read-only editor."""
        return self._editor

    def set_lines(self, lines: Sequence[str]) -> None:
        """Replace the excerpt content with sanitized log lines."""
        self._editor.setPlainText("\n".join(lines))

    def _apply_editor_sheet(self) -> None:
        palette = self.palette()
        colors = common.semantic_colors(palette)
        self._editor.setStyleSheet(
            _EDITOR_SHEET.format(
                background=colors.surface,
                color=colors.text,
                border=colors.border,
                radius=tokens.RADIUS_CONTROL,
                padding=tokens.SPACE_XS,
            )
        )


__all__ = ["LogExcerpt"]
