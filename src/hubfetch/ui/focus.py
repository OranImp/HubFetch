"""Visible keyboard focus ring for every interactive primitive.

DESIGN.md Section 3 requires full keyboard reachability with visible focus on
every interactive element. Native styles either hide the focus rectangle or
render it inconsistently across controls, so we draw one consistent ring in the
locked Action Blue token. The ring is a shape plus a color, and it renders
whenever an interactive widget holds focus (visible on every interactive
element per DESIGN.md Section 3); hover without focus never shows it, so it
serves wayfinding rather than decorating pointer interaction.
"""

from __future__ import annotations

from typing import override

from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import (
    QApplication,
    QProxyStyle,
    QStyle,
    QStyleOption,
    QStyleOptionComplex,
    QStyleOptionFocusRect,
    QWidget,
)

from . import tokens

_RING_WIDTH_PX: int = 2
_RING_PAD_PX: int = 1


def draw_focus_ring(painter: QPainter, rect: QRect) -> None:
    """Stroke the rounded Action Blue focus ring inside ``rect``.

    Shared by the style-level hook and by style-sheeted primitives that the
    style hook cannot reach (the stylesheet engine paints their bodies without
    emitting focus-frame primitives, so those widgets draw the ring themselves).
    """
    ring = rect.adjusted(_RING_PAD_PX, _RING_PAD_PX, -_RING_PAD_PX, -_RING_PAD_PX)
    painter.save()
    painter.setPen(QPen(QColor(tokens.ACTION_BLUE), _RING_WIDTH_PX))
    painter.setBrush(Qt.BrushStyle.NoBrush)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    radius = float(tokens.RADIUS_CONTROL)
    painter.drawRoundedRect(ring, radius, radius)
    painter.restore()


class FocusRingStyle(QProxyStyle):
    """Proxy style that replaces the native focus rectangle with a token ring.

    Only :data:`QStyle.PrimitiveElement.PE_FrameFocusRect` is intercepted; every
    other primitive and control metric delegates to the wrapped base style so the
    locked palette and Fusion geometry remain in force.
    """

    @override
    def drawPrimitive(
        self,
        element: QStyle.PrimitiveElement,
        option: QStyleOption,
        painter: QPainter,
        widget: QWidget | None = None,
    ) -> None:
        """Draw a rounded Action Blue ring for keyboard focus, else delegate."""
        if element != QStyle.PrimitiveElement.PE_FrameFocusRect:
            super().drawPrimitive(element, option, painter, widget)
            return
        if not isinstance(option, QStyleOptionFocusRect):
            super().drawPrimitive(element, option, painter, widget)
            return
        focus_state = (
            QStyle.StateFlag.State_KeyboardFocusChange | QStyle.StateFlag.State_HasFocus
        )
        if not option.state & focus_state:
            # Hide the ring unless a widget actually holds focus.
            return
        ring = option.rect.adjusted(
            _RING_PAD_PX, _RING_PAD_PX, -_RING_PAD_PX, -_RING_PAD_PX
        )
        painter.save()
        pen = QPen(QColor(tokens.ACTION_BLUE), _RING_WIDTH_PX)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        radius = float(tokens.RADIUS_CONTROL)
        painter.drawRoundedRect(QRect(ring), radius, radius)
        painter.restore()

    @override
    def drawControl(
        self,
        element: QStyle.ControlElement,
        option: QStyleOption,
        painter: QPainter,
        widget: QWidget | None = None,
    ) -> None:
        """Add the focus ring to buttons whose native paint omits it.

        Fusion never emits ``PE_FrameFocusRect`` while painting push and tool
        buttons, so without this hook focused commands would carry no visible
        focus cue at all (DESIGN.md 3 requires one on every interactive
        element). The ring is synthesized after the base control is drawn.
        """
        super().drawControl(element, option, painter, widget)
        if element != QStyle.ControlElement.CE_PushButton:
            return
        if not option.state & QStyle.StateFlag.State_HasFocus:
            return
        self._draw_focus_ring(option, painter, widget)

    @override
    def drawComplexControl(
        self,
        control: QStyle.ComplexControl,
        option: QStyleOptionComplex,
        painter: QPainter,
        widget: QWidget | None = None,
    ) -> None:
        """Add the focus ring to tool buttons painted via complex controls."""
        super().drawComplexControl(control, option, painter, widget)
        if control != QStyle.ComplexControl.CC_ToolButton:
            return
        if not option.state & QStyle.StateFlag.State_HasFocus:
            return
        self._draw_focus_ring(option, painter, widget)

    def _draw_focus_ring(
        self, option: QStyleOption, painter: QPainter, widget: QWidget | None
    ) -> None:
        """Synthesize the focus primitive for a control whose paint omits it."""
        frame = QStyleOptionFocusRect()
        frame.state = (
            QStyle.StateFlag.State_KeyboardFocusChange
            | QStyle.StateFlag.State_HasFocus
            | QStyle.StateFlag.State_Enabled
        )
        frame.rect = option.rect.adjusted(0, 0, -1, -1)
        self.drawPrimitive(
            QStyle.PrimitiveElement.PE_FrameFocusRect, frame, painter, widget
        )


def install_focus_ring(base: QStyle) -> FocusRingStyle:
    """Wrap ``base`` with the focus-ring proxy and install it application-wide.

    Returns the installed proxy so callers can assert on it. Installation is
    idempotent (a proxy is never wrapped twice) and best-effort: when no
    application instance exists the proxy is still returned for inspection.
    """
    if isinstance(base, FocusRingStyle):
        return base
    ring = FocusRingStyle(base)
    app = QApplication.instance()
    if isinstance(app, QApplication):
        app.setStyle(ring)
    return ring


def make_focusable(widget: QWidget, accessible_name: str) -> QWidget:
    """Give a widget strong keyboard focus and a required accessible name.

    Primitives call this so every interactive element is reachable by Tab and is
    announced with a stable name by accessibility APIs. An empty name is a
    contract error surfaced by the :class:`MissingAccessibleNameError` guard used
    icon buttons; here we keep the assignment simple and let callers validate.
    """
    widget.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
    widget.setAccessibleName(accessible_name)
    return widget


__all__ = ["FocusRingStyle", "draw_focus_ring", "install_focus_ring", "make_focusable"]
