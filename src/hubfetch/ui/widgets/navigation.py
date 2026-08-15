"""Flat top-level navigation item (DESIGN.md research: navigation-basics).

Navigation is flat, icon-plus-text, and never scrolls (DESIGN.md 8.1). The
item is a checkable push button so selection state is conveyed by shape
(checked styling) plus a text description, never by color alone, and the
selected page is announced through the accessible description.
"""

from __future__ import annotations

from typing import Final

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import QPushButton

from hubfetch.ui import focus, icons, tokens
from hubfetch.ui.widgets import common

NAVIGATION_ITEM_HEIGHT: Final[int] = tokens.NAV_ITEM_HEIGHT
"""Fixed navigation item height contract traced to DESIGN.md spacing."""

_ITEM_SHEET = (
    "QPushButton {{ {body} }}"
    "QPushButton:hover {{ {hover} }}"
    "QPushButton:pressed {{ {pressed} }}"
    "QPushButton:checked {{ {checked} }}"
    "QPushButton:disabled {{ {disabled} }}"
)

_SELECTED_DESCRIPTION = "当前页面"
"""Shape/text cue announced when this item is the active destination."""


class NavigationItem(QPushButton):
    """A 40 px navigation command with a 20 px icon and selection state."""

    def __init__(self, icon_name: icons.IconName, text: str) -> None:
        """Build a flat navigation item with left-aligned icon and label."""
        super().__init__(text)
        self._icon_name: icons.IconName = icon_name
        self._selected: bool = False
        self.setCheckable(True)
        self.setChecked(False)
        self.setIcon(
            icons.icon(
                icon_name, self.palette().buttonText().color(), tokens.ICON_COMMAND
            )
        )
        self.setIconSize(QSize(tokens.ICON_COMMAND, tokens.ICON_COMMAND))
        self.setFixedHeight(NAVIGATION_ITEM_HEIGHT)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        focus.make_focusable(self, text)
        self.setStyleSheet(self._sheet())

    def icon_name(self) -> icons.IconName:
        """Return the leading Lucide glyph."""
        return self._icon_name

    def set_selected(self, selected: bool) -> None:
        """Mark this item current; checked styling and text carry the state."""
        self._selected = selected
        self.setChecked(selected)
        self.setAccessibleDescription(_SELECTED_DESCRIPTION if selected else "")

    def is_selected(self) -> bool:
        """Return whether this item is the active destination."""
        return self._selected

    def _sheet(self) -> str:
        palette = self.palette()
        colors = common.semantic_colors(palette)
        tint = common.hover_tint(palette)
        body = (
            f"text-align: left; background: transparent;"
            f" color: {palette.buttonText().color().name()};"
            f" border: none; border-radius: {tokens.RADIUS_CONTROL}px;"
            f" padding: {tokens.SPACE_SM}px;"
        )
        hover = f"background-color: {tint};"
        pressed = f"background-color: {tint};"
        checked = (
            f"background-color: {colors.surface};"
            f" border: 1px solid {colors.border};"
            f" font-weight: 600;"
        )
        disabled = f"color: {palette.placeholderText().color().name()};"
        return _ITEM_SHEET.format(
            body=body, hover=hover, pressed=pressed, checked=checked, disabled=disabled
        )


__all__ = ["NAVIGATION_ITEM_HEIGHT", "NavigationItem"]
