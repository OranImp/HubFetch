"""Status icon/text pairs and inline recovery actions.

Status is always an icon *and* text (DESIGN.md 5.6, 6.2): every severity maps
to a distinct Lucide glyph so shape carries meaning alongside color, and the
text label is the accessible name. Recovery actions pair an actionable message
with exactly one command button, mirroring the error contract that every
failure names its stage and offers one executable next step (DESIGN.md 10).
"""

from __future__ import annotations

from enum import StrEnum, unique

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QWidget

from hubfetch.ui import focus, icons, tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.labels import CaptionLabel


@unique
class StatusSeverity(StrEnum):
    """Closed status semantics rendered as icon/text pairs."""

    QUEUED = "queued"
    ACTIVE = "active"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"
    LOADING = "loading"
    INFO = "info"


_SEVERITY_ICONS: dict[StatusSeverity, icons.IconName] = {
    StatusSeverity.QUEUED: icons.IconName.CLOCK,
    StatusSeverity.ACTIVE: icons.IconName.ACTIVITY,
    StatusSeverity.SUCCEEDED: icons.IconName.CIRCLE_CHECK,
    StatusSeverity.FAILED: icons.IconName.TRIANGLE_ALERT,
    StatusSeverity.CANCELLED: icons.IconName.CIRCLE_X,
    StatusSeverity.INTERRUPTED: icons.IconName.CIRCLE_PAUSE,
    StatusSeverity.LOADING: icons.IconName.LOADER_CIRCLE,
    StatusSeverity.INFO: icons.IconName.INFO,
}


class StatusPair(QWidget):
    """A 16 px status glyph beside its text label."""

    def __init__(self, severity: StatusSeverity, text: str) -> None:
        """Render the severity glyph plus text; text is the accessible name."""
        super().__init__()
        self._severity: StatusSeverity = severity
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_XS)
        self._icon: QLabel = QLabel()
        self._icon.setFixedSize(tokens.ICON_INLINE, tokens.ICON_INLINE)
        self._icon.setPixmap(
            icons.icon(
                _SEVERITY_ICONS[severity],
                self.palette().text().color(),
                tokens.ICON_INLINE,
            ).pixmap(tokens.ICON_INLINE, tokens.ICON_INLINE)
        )
        self._text: QLabel = QLabel(text)
        layout.addWidget(self._icon)
        layout.addWidget(self._text, stretch=1)
        self.setAccessibleName(text)
        self.setToolTip(text)

    def severity(self) -> StatusSeverity:
        """Return the status semantics this pair renders."""
        return self._severity

    def has_icon(self) -> bool:
        """Return whether the glyph rendered (never blank)."""
        return not self._icon.pixmap().isNull()

    def text_label(self) -> QLabel:
        """Expose the text half of the pair."""
        return self._text


class InlineRecoveryAction(QWidget):
    """One actionable message plus the single command that recovers from it."""

    triggered: Signal = Signal()

    def __init__(self, message: str, action_label: str) -> None:
        """Pair the message triangle with a recovery command button."""
        super().__init__()
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_SM)
        icon_label = QLabel()
        icon_label.setFixedSize(tokens.ICON_INLINE, tokens.ICON_INLINE)
        icon_label.setPixmap(
            icons.icon(
                icons.IconName.TRIANGLE_ALERT,
                self.palette().text().color(),
                tokens.ICON_INLINE,
            ).pixmap(tokens.ICON_INLINE, tokens.ICON_INLINE)
        )
        self._message: CaptionLabel = CaptionLabel(message)
        self._button: ActionButton = ActionButton(action_label)
        self._button.clicked.connect(self.triggered.emit)
        layout.addWidget(icon_label)
        layout.addWidget(self._message, stretch=1)
        layout.addWidget(self._button)
        focus.make_focusable(self._button, action_label)
        self.setAccessibleName(message)

    def button(self) -> ActionButton:
        """Expose the recovery command."""
        return self._button

    def message_label(self) -> CaptionLabel:
        """Expose the actionable message text."""
        return self._message

    def trigger(self) -> None:
        """Programmatically activate the recovery action."""
        self.triggered.emit()


__all__ = ["InlineRecoveryAction", "StatusPair", "StatusSeverity"]
