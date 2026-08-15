"""Empty, loading, and error state blocks plus their recovery actions.

State blocks fill a surface when there is nothing to list, work is in flight,
or a transfer has failed. Each block pairs an icon with text so its meaning is
never color-only (DESIGN.md 5.6), and the error block embeds exactly one inline
recovery action, matching the contract that every failure names its stage and
offers a single executable next step (DESIGN.md 10).
"""

from __future__ import annotations

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor, QPainter, QPixmap
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.labels import CaptionLabel
from hubfetch.ui.widgets.status import InlineRecoveryAction

_SPINNER_SIZE: int = tokens.ICON_COMMAND


class EmptyBlock(QWidget):
    """A quiet placeholder shown when a list or detail pane has no content."""

    def __init__(
        self, title: str, description: str, action_label: str | None = None
    ) -> None:
        """Render the inbox glyph, title, help text, and optional command."""
        super().__init__()
        self._action: ActionButton | None = None
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_XL, tokens.SPACE_LG, tokens.SPACE_XL
        )
        layout.setSpacing(tokens.SPACE_SM)
        glyph = QLabel()
        glyph.setPixmap(
            icons.icon(
                icons.IconName.INBOX,
                self.palette().placeholderText().color(),
                tokens.ICON_COMMAND,
            ).pixmap(tokens.ICON_COMMAND, tokens.ICON_COMMAND)
        )
        layout.addWidget(glyph, alignment=Qt.AlignmentFlag.AlignLeading)
        title_label = QLabel(title)
        description_label = CaptionLabel(description)
        description_label.setWordWrap(True)
        layout.addWidget(title_label)
        layout.addWidget(description_label)
        if action_label is not None:
            button = ActionButton(action_label)
            self._action = button
            layout.addWidget(button, alignment=Qt.AlignmentFlag.AlignLeading)
        layout.addStretch(1)
        self.setAccessibleName(title)

    def action_button(self) -> ActionButton | None:
        """Return the block's command button, if one was requested."""
        return self._action


class LoadingBlock(QWidget):
    """A spinner plus message shown while content is loading.

    Under a reduced-motion preference the spinner is drawn statically so no
    decorative animation runs (DESIGN.md 7.2); the message text alone still
    conveys the loading state.
    """

    def __init__(self, message: str, motion: tokens.MotionPreference) -> None:
        """Build the spinner and message; animate only under full motion."""
        super().__init__()
        self._timer: QTimer = QTimer(self)
        self._angle: int = 0
        self._icon_label: QLabel = QLabel()
        self._render_frame()
        layout = QHBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_SM)
        layout.addWidget(self._icon_label)
        layout.addWidget(QLabel(message), stretch=1)
        self.setAccessibleName(message)
        if motion is tokens.MotionPreference.FULL:
            self._timer.setInterval(tokens.FEEDBACK_MAX_MS)
            self._timer.timeout.connect(self._advance)
            self._timer.start()

    def spinner_active(self) -> bool:
        """Return whether the spinner animation is currently running."""
        return self._timer.isActive()

    def stop(self) -> None:
        """Halt the spinner for deterministic capture; text still conveys state."""
        self._timer.stop()

    def set_motion_preference(self, motion: tokens.MotionPreference) -> None:
        """Start or stop the spinner to match the active motion preference."""
        if motion is tokens.MotionPreference.FULL:
            if not self._timer.isActive():
                self._timer.start()
            return
        self._timer.stop()

    def _advance(self) -> None:
        self._angle = (self._angle + 45) % 360
        self._render_frame()

    def _render_frame(self) -> None:
        source = icons.icon_pixmap(
            icons.IconName.LOADER_CIRCLE, self.palette().text().color(), _SPINNER_SIZE
        )
        rotated = QPixmap(_SPINNER_SIZE, _SPINNER_SIZE)
        rotated.fill(QColor(0, 0, 0, 0))
        painter = QPainter(rotated)
        try:
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            half = _SPINNER_SIZE / 2
            painter.translate(half, half)
            painter.rotate(float(self._angle))
            painter.drawPixmap(int(-half), int(-half), source)
        finally:
            painter.end()
        self._icon_label.setPixmap(rotated)


class ErrorBlock(QWidget):
    """A failure message plus exactly one inline recovery action."""

    def __init__(self, title: str, detail: str, recovery_label: str) -> None:
        """Show the alert glyph, title, detail, and recovery command."""
        super().__init__()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_SM)
        header = QHBoxLayout()
        header.setSpacing(tokens.SPACE_SM)
        glyph = QLabel()
        glyph.setPixmap(
            icons.icon(
                icons.IconName.TRIANGLE_ALERT,
                self.palette().text().color(),
                tokens.ICON_COMMAND,
            ).pixmap(tokens.ICON_COMMAND, tokens.ICON_COMMAND)
        )
        header.addWidget(glyph)
        header.addWidget(QLabel(title), stretch=1)
        layout.addLayout(header)
        detail_label = CaptionLabel(detail)
        detail_label.setWordWrap(True)
        layout.addWidget(detail_label)
        self._recovery: InlineRecoveryAction = InlineRecoveryAction(
            detail, recovery_label
        )
        layout.addWidget(self._recovery)
        self.setAccessibleName(title)

    def recovery_action(self) -> InlineRecoveryAction:
        """Return the single recovery action carried by this block."""
        return self._recovery


__all__ = ["EmptyBlock", "ErrorBlock", "LoadingBlock"]
