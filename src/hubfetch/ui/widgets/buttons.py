"""Icon and text command buttons with accessible state explanations.

Command buttons carry a fixed height, keyboard focus, and an accessible name.
Disabled states expose a machine-readable reason through the accessible
description so assistive tech can explain *why* a command is unavailable
(DESIGN.md 6.2). Loading swaps in the spinner glyph instead of animating
decoratively, and the button is suspended while the action runs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import override

from PySide6.QtCore import QSize
from PySide6.QtGui import QIcon, QPainter, QPaintEvent
from PySide6.QtWidgets import QPushButton, QToolButton

from hubfetch.ui import focus, icons, tokens
from hubfetch.ui.widgets import common

_BUTTON_SHEET = (
    "QPushButton {{ {body} }}"
    "QPushButton:hover {{ {hover} }}"
    "QPushButton:pressed {{ {pressed} }}"
    "QPushButton:disabled {{ {disabled} }}"
)


@dataclass(frozen=True, slots=True)
class MissingAccessibleNameError(ValueError):
    """An icon-only command was constructed without an accessible name.

    Icon buttons have no visible text, so the accessible name doubles as the
    tooltip and the screen-reader label; omitting it is a contract error rather
    than shipping an unnamed control (DESIGN.md 5.6).
    """

    reason: str

    @override
    def __str__(self) -> str:
        return f"missing accessible name: {self.reason}"


class IconButton(QToolButton):
    """A square icon-only command with a mandatory tooltip and accessible name."""

    def __init__(
        self,
        icon_name: icons.IconName,
        accessible_name: str,
        tooltip: str | None = None,
        icon_size: int = tokens.ICON_COMMAND,
    ) -> None:
        """Raise :class:`MissingAccessibleNameError` when no name is supplied."""
        super().__init__()
        if not accessible_name.strip():
            raise MissingAccessibleNameError(
                reason=f"icon command {icon_name.value} needs an accessible name"
            )
        self._icon_name: icons.IconName = icon_name
        shown = tooltip if tooltip is not None else accessible_name
        self.setToolTip(shown)
        self.setAccessibleName(accessible_name)
        self.setAccessibleDescription(shown)
        self.setAutoRaise(True)
        self.setFixedSize(tokens.CONTROL_HEIGHT, tokens.CONTROL_HEIGHT)
        self.setIconSize(QSize(icon_size, icon_size))
        self.setIcon(
            icons.icon(icon_name, self.palette().buttonText().color(), icon_size)
        )
        focus.make_focusable(self, accessible_name)

    def icon_name(self) -> icons.IconName:
        """Return the Lucide glyph this command renders."""
        return self._icon_name

    @override
    def paintEvent(self, event: QPaintEvent) -> None:
        """Paint the tool button, then the focus ring while focused."""
        super().paintEvent(event)
        if self.hasFocus():
            painter = QPainter(self)
            try:
                focus.draw_focus_ring(painter, self.rect())
            finally:
                painter.end()


class ActionButton(QPushButton):
    """A text command with an optional primary treatment and explained states."""

    def __init__(self, text: str, *, primary: bool = False) -> None:
        """Fix the control height and record the primary role for styling."""
        super().__init__(text)
        self._primary: bool = primary
        self._disabled_reason: str | None = None
        self._loading: bool = False
        self.setMinimumHeight(tokens.CONTROL_HEIGHT)
        self.setMaximumHeight(tokens.CONTROL_HEIGHT)
        self.setMinimumWidth(tokens.BUTTON_MIN_WIDTH)
        focus.make_focusable(self, text)
        self._apply_style()

    def is_primary(self) -> bool:
        """Return whether this is the visually emphasized command."""
        return self._primary

    @override
    def paintEvent(self, event: QPaintEvent) -> None:
        """Paint the styled button, then the focus ring while focused.

        The stylesheet engine paints the body but emits no focus-frame
        primitive for style-sheeted buttons, so the style-level ring hook
        never sees them; the button therefore draws its own Action Blue ring
        (shape plus color) whenever it holds focus (DESIGN.md 3).
        """
        super().paintEvent(event)
        if self.hasFocus():
            painter = QPainter(self)
            try:
                focus.draw_focus_ring(painter, self.rect())
            finally:
                painter.end()

    def set_disabled_reason(self, reason: str | None) -> None:
        """Disable with an accessible explanation, or clear the reason."""
        self._disabled_reason = reason
        if reason is not None:
            self.setEnabled(False)
            self.setAccessibleDescription(reason)
            return
        self.setAccessibleDescription("")
        if not self._loading:
            self.setEnabled(True)

    def set_loading(self, loading: bool, loading_text: str = "") -> None:
        """Suspend the command and show the spinner glyph while working."""
        self._loading = loading
        if loading:
            spinner = icons.icon(
                icons.IconName.LOADER_CIRCLE,
                self.palette().buttonText().color(),
                tokens.ICON_INLINE,
            )
            self.setIcon(spinner)
            self.setEnabled(False)
            if loading_text:
                self.setAccessibleDescription(loading_text)
            return
        self.setIcon(QIcon())
        if self._disabled_reason is None:
            self.setEnabled(True)

    def _apply_style(self) -> None:
        """Style the button from palette-derived token colors with clear states."""
        palette = self.palette()
        colors = common.semantic_colors(palette)
        tint = common.hover_tint(palette)
        if self._primary:
            body = (
                f"background-color: {tokens.ACTION_BLUE}; color: {tokens.SURFACE};"
                f" border: 1px solid {tokens.ACTION_BLUE};"
                f" border-radius: {tokens.RADIUS_CONTROL}px;"
                f" padding: {tokens.SPACE_SM}px;"
            )
        else:
            body = (
                f"background-color: {colors.surface};"
                f" color: {palette.buttonText().color().name()};"
                f" border: 1px solid {colors.border};"
                f" border-radius: {tokens.RADIUS_CONTROL}px;"
                f" padding: {tokens.SPACE_SM}px;"
            )
        hover = f"background-color: {tint};"
        pressed = f"background-color: {tint}; border-color: {colors.text};"
        disabled = (
            f"background-color: {colors.window};"
            f" color: {palette.placeholderText().color().name()};"
            f" border-color: {colors.border};"
        )
        self.setStyleSheet(
            _BUTTON_SHEET.format(
                body=body, hover=hover, pressed=pressed, disabled=disabled
            )
        )


__all__ = ["ActionButton", "IconButton", "MissingAccessibleNameError"]
