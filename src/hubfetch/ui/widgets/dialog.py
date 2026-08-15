"""Dialog/sheet anatomy: title bar, scrollable body, command footer.

Transient creation flows render inside a sheet (DESIGN.md 6.1). The anatomy is
fixed: a title with a close command, a body region the caller fills, and a
footer command row whose insertion order is preserved so keyboard users meet
secondary then primary actions in a stable sequence. The close button carries
an accessible name and keyboard focus.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, override

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.buttons import ActionButton, IconButton

if TYPE_CHECKING:
    from PySide6.QtGui import QKeyEvent

_SHEET_TEMPLATE: Final[str] = (
    "QFrame {{ background-color: {background};"
    " border: 1px solid {border};"
    " border-radius: {radius}px; }}"
)


class Sheet(QFrame):
    """A titled panel with a close command, body slot, and ordered footer."""

    def __init__(self, title: str) -> None:
        """Build title bar, empty body container, and empty footer row."""
        super().__init__()
        self._footer_actions: list[ActionButton] = []
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setAccessibleName(title)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        outer.setSpacing(tokens.SPACE_SM)
        header = QHBoxLayout()
        header.setSpacing(tokens.SPACE_SM)
        self._title: QLabel = QLabel(title)
        font = self._title.font()
        font.setBold(True)
        self._title.setFont(font)
        header.addWidget(self._title, stretch=1)
        self._close: IconButton = IconButton(
            icons.IconName.X, accessible_name=f"关闭{title}"
        )
        header.addWidget(self._close)
        outer.addLayout(header)
        self._body: QWidget = QWidget(self)
        self._body_layout: QVBoxLayout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(tokens.SPACE_SM)
        outer.addWidget(self._body, stretch=1)
        self._footer: QHBoxLayout = QHBoxLayout()
        self._footer.setSpacing(tokens.SPACE_SM)
        self._footer.addStretch(1)
        outer.addLayout(self._footer)
        self._apply_sheet()

    def title_label(self) -> QLabel:
        """Expose the sheet title label."""
        return self._title

    def close_button(self) -> IconButton:
        """Expose the close command button."""
        return self._close

    def body(self) -> QWidget:
        """Return the body container for callers to populate."""
        return self._body

    def body_layout(self) -> QVBoxLayout:
        """Return the body layout for callers to populate."""
        return self._body_layout

    def add_footer_action(self, button: ActionButton) -> None:
        """Append a command to the footer preserving insertion order."""
        self._footer_actions.append(button)
        self._footer.addWidget(button)

    def footer_actions(self) -> list[ActionButton]:
        """Return footer commands in the order they were added."""
        return list(self._footer_actions)

    @override
    def keyPressEvent(self, event: QKeyEvent) -> None:
        """Hide on Escape so keyboard users can dismiss the sheet."""
        if event.key() == Qt.Key.Key_Escape:
            self.hide()
            return
        super().keyPressEvent(event)

    def _apply_sheet(self) -> None:
        colors = common.semantic_colors(self.palette())
        self.setStyleSheet(
            _SHEET_TEMPLATE.format(
                background=colors.surface,
                border=colors.border,
                radius=tokens.RADIUS_PANEL,
            )
        )


__all__ = ["Sheet"]
