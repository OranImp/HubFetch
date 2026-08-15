"""Text, path, revision, and proxy input fields with inline error rows.

Every field keeps a fixed 32 px input height, a visible label buddy, an
accessible name, and an error row that pairs a triangle-alert icon with message
text (never color alone). Disable reasons and error messages are exposed through
the editor's accessible description so assistive tech hears the exact state.
Technical fields (path, revision, proxy) render in the bundled Cascadia Mono
with a Consolas fallback (DESIGN.md 5.2).
"""

from __future__ import annotations

from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QVBoxLayout, QWidget

from hubfetch.ui import focus, fonts, icons, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.labels import CaptionLabel

_ERROR_PREFIX_WIDTH: int = tokens.ICON_INLINE


class TextField(QWidget):
    """A labeled single-line input with inline error and disable explanations."""

    def __init__(
        self, label_text: str, *, placeholder: str = "", mono: bool = False
    ) -> None:
        """Build label, 32 px editor, and a hidden error row."""
        super().__init__()
        self._error_text: str | None = None
        self._disabled_reason: str | None = None
        self._editor: QLineEdit = QLineEdit()
        label = QLabel(label_text)
        label.setBuddy(self._editor)
        if placeholder:
            self._editor.setPlaceholderText(placeholder)
        self._editor.setAccessibleName(label_text)
        self._editor.setFixedHeight(tokens.CONTROL_HEIGHT)
        self._editor.setMinimumWidth(tokens.FIELD_MIN_WIDTH)
        if mono:
            self._editor.setFont(fonts.mono_font(tokens.BODY_SIZE - 2))
        focus.make_focusable(self._editor, label_text)
        self._apply_editor_sheet()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_XS)
        layout.addWidget(label)
        layout.addWidget(self._editor)
        error_widgets = self._build_error_row()
        self._error_row: QWidget = error_widgets[0]
        self._error_icon: QLabel = error_widgets[1]
        self._error_label: CaptionLabel = error_widgets[2]
        layout.addWidget(self._error_row)
        self._error_row.hide()
        self.setAccessibleName(label_text)

    def editor(self) -> QLineEdit:
        """Expose the underlying line editor."""
        return self._editor

    def input_height(self) -> int:
        """Return the locked editor height contract."""
        return self._editor.height()

    def set_text(self, text: str) -> None:
        """Set the editor content."""
        self._editor.setText(text)

    def error_message(self) -> str | None:
        """Return the active inline error message, if any."""
        return self._error_text

    def set_error(self, message: str | None) -> None:
        """Show or clear the error row and mirror the message accessibly."""
        self._error_text = message
        if message is None:
            self._error_row.hide()
            self._sync_description()
            self._apply_editor_sheet()
            return
        self._error_label.setText(message)
        self._error_icon.setPixmap(
            icons.icon(
                icons.IconName.TRIANGLE_ALERT,
                self.palette().text().color(),
                tokens.ICON_INLINE,
            ).pixmap(tokens.ICON_INLINE, tokens.ICON_INLINE)
        )
        self._error_row.show()
        self._editor.setAccessibleDescription(message)
        self._apply_editor_sheet(error=True)

    def set_disabled_reason(self, reason: str | None) -> None:
        """Disable the editor with an accessible explanation, or restore it."""
        self._disabled_reason = reason
        if reason is not None:
            self._editor.setEnabled(False)
            self._editor.setAccessibleDescription(reason)
            return
        self._editor.setEnabled(True)
        self._sync_description()

    def _sync_description(self) -> None:
        reason = self._disabled_reason
        description = (
            reason if reason is not None and not self._editor.isEnabled() else ""
        )
        self._editor.setAccessibleDescription(description)

    def _build_error_row(self) -> tuple[QWidget, QLabel, CaptionLabel]:
        row = QWidget(self)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(tokens.SPACE_XS)
        icon_label = QLabel()
        icon_label.setFixedSize(_ERROR_PREFIX_WIDTH, _ERROR_PREFIX_WIDTH)
        message = CaptionLabel("")
        row_layout.addWidget(icon_label)
        row_layout.addWidget(message, stretch=1)
        return row, icon_label, message

    def _apply_editor_sheet(self, *, error: bool = False) -> None:
        palette = self.palette()
        colors = common.semantic_colors(palette)
        border = colors.text if error else colors.border
        sheet = (
            f"QLineEdit {{ background-color: {palette.base().color().name()};"
            f" border: 1px solid {border};"
            f" border-radius: {tokens.RADIUS_CONTROL}px;"
            f" padding: {tokens.SPACE_XS}px {tokens.SPACE_SM}px; }}"
        )
        self._editor.setStyleSheet(sheet)


class PathField(TextField):
    """A filesystem destination input rendered in the mono data font."""

    def __init__(self, label_text: str, *, placeholder: str = "") -> None:
        """Build a mono text field styled for local paths."""
        super().__init__(label_text, placeholder=placeholder, mono=True)


class RevisionField(TextField):
    """A branch/tag/commit revision input rendered in the mono data font."""

    def __init__(self, label_text: str, *, placeholder: str = "") -> None:
        """Build a mono text field styled for revisions."""
        super().__init__(label_text, placeholder=placeholder, mono=True)


class ProxyField(TextField):
    """A manual proxy URL input rendered in the mono data font."""

    def __init__(self, label_text: str, *, placeholder: str = "") -> None:
        """Build a mono text field styled for proxy URLs."""
        super().__init__(label_text, placeholder=placeholder, mono=True)


__all__ = ["PathField", "ProxyField", "RevisionField", "TextField"]
