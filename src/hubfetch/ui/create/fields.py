"""Labeled combo and multiline pattern primitives for the creation forms.

The shared primitive library exposes single-line text fields and the
repository-type selector, but the creation flows need two more controls: a
labeled combo box for closed choice sets (conflict policy, auth source, proxy
mode) and a multiline editor for newline-separated include/exclude patterns.
Both mirror the primitive contract: a visible label buddy, accessible name,
32 px control height (or a bounded multiline height), and an inline error row
that pairs a triangle-alert icon with text, never color alone.
"""

from __future__ import annotations

from typing import Final

from PySide6.QtWidgets import (
    QComboBox,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QVBoxLayout,
    QWidget,
)

from hubfetch.ui import focus, icons, tokens
from hubfetch.ui.widgets.labels import CaptionLabel

_PATTERN_HEIGHT: Final = 64
_ERROR_ICON_SIZE: Final = tokens.ICON_INLINE


class LabeledCombo(QWidget):
    """A labeled combo box with a fixed height, buddy, and error row."""

    def __init__(self, label_text: str, choices: tuple[tuple[str, str], ...]) -> None:
        """Build label plus combo; ``choices`` pairs stable key with label."""
        super().__init__()
        self._keys: tuple[str, ...] = tuple(key for key, _label in choices)
        self._combo: QComboBox = QComboBox()
        label = QLabel(label_text)
        label.setBuddy(self._combo)
        self._combo.setAccessibleName(label_text)
        self._combo.setFixedHeight(tokens.CONTROL_HEIGHT)
        self._combo.setMinimumWidth(tokens.FIELD_MIN_WIDTH)
        for key, display in choices:
            self._combo.addItem(display, userData=key)
        self._error: CaptionLabel | None = None
        self._error_row: QWidget
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_1)
        layout.addWidget(label)
        layout.addWidget(self._combo)
        self._error_row = self._build_error_row(layout)
        self._error_row.hide()
        self.setAccessibleName(label_text)
        focus.make_focusable(self._combo, label_text)

    def combo(self) -> QComboBox:
        """Expose the underlying combo box."""
        return self._combo

    def current_key(self) -> str:
        """Return the stable key of the selected choice."""
        index = self._combo.currentIndex()
        if index < 0 or index >= len(self._keys):
            return ""
        return self._keys[index]

    def set_current_key(self, key: str) -> None:
        """Select a choice by its stable key."""
        try:
            index = self._keys.index(key)
        except ValueError as error:
            message = f"unknown choice key {key!r}"
            raise ValueError(message) from error
        self._combo.setCurrentIndex(index)

    def set_error(self, message: str | None) -> None:
        """Show or clear the inline error row and mirror it accessibly."""
        if self._error is None:
            return
        if message is None:
            self._error_row.hide()
            self._combo.setAccessibleDescription("")
            return
        self._error.setText(message)
        self._error_row.show()
        self._combo.setAccessibleDescription(message)

    def _build_error_row(self, parent_layout: QVBoxLayout) -> QWidget:
        row = QWidget(self)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(tokens.SPACE_XS)
        icon_label = QLabel()
        icon_label.setFixedSize(_ERROR_ICON_SIZE, _ERROR_ICON_SIZE)
        icon_label.setPixmap(
            icons.icon(
                icons.IconName.TRIANGLE_ALERT,
                self.palette().text().color(),
                _ERROR_ICON_SIZE,
            ).pixmap(_ERROR_ICON_SIZE, _ERROR_ICON_SIZE)
        )
        self._error = CaptionLabel("")
        row_layout.addWidget(icon_label)
        row_layout.addWidget(self._error, stretch=1)
        parent_layout.addWidget(row)
        return row


class PatternField(QWidget):
    """A labeled multiline editor for newline-separated glob patterns."""

    def __init__(self, label_text: str, *, placeholder: str = "") -> None:
        """Build label, bounded multiline editor, and a hidden error row."""
        super().__init__()
        self._editor: QPlainTextEdit = QPlainTextEdit()
        self._editor.setAccessibleName(label_text)
        self._editor.setFixedHeight(_PATTERN_HEIGHT)
        self._editor.setMinimumWidth(tokens.FIELD_MIN_WIDTH)
        if placeholder:
            self._editor.setPlaceholderText(placeholder)
        label = QLabel(label_text)
        label.setBuddy(self._editor)
        focus.make_focusable(self._editor, label_text)
        self._error_text: str | None = None
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_1)
        layout.addWidget(label)
        layout.addWidget(self._editor)
        error_widgets = self._build_error_row()
        self._error_row: QWidget = error_widgets[0]
        self._error_icon: QLabel = error_widgets[1]
        self._error_label: CaptionLabel = error_widgets[2]
        layout.addWidget(self._error_row)
        self._error_row.hide()
        self.setAccessibleName(label_text)

    def editor(self) -> QPlainTextEdit:
        """Expose the underlying multiline editor."""
        return self._editor

    def set_text(self, text: str) -> None:
        """Set the editor content."""
        self._editor.setPlainText(text)

    def text(self) -> str:
        """Return the current editor content."""
        return self._editor.toPlainText()

    def error_text(self) -> str | None:
        """Return the currently displayed inline error message, if any."""
        return self._error_text

    def set_error(self, message: str | None) -> None:
        """Show or clear the inline error row and mirror it accessibly."""
        self._error_text = message
        if message is None:
            self._error_row.hide()
            self._editor.setAccessibleDescription("")
            return
        self._error_label.setText(message)
        self._error_icon.setPixmap(
            icons.icon(
                icons.IconName.TRIANGLE_ALERT,
                self.palette().text().color(),
                _ERROR_ICON_SIZE,
            ).pixmap(_ERROR_ICON_SIZE, _ERROR_ICON_SIZE)
        )
        self._error_row.show()
        self._editor.setAccessibleDescription(message)

    def _build_error_row(self) -> tuple[QWidget, QLabel, CaptionLabel]:
        row = QWidget(self)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(tokens.SPACE_XS)
        icon_label = QLabel()
        icon_label.setFixedSize(_ERROR_ICON_SIZE, _ERROR_ICON_SIZE)
        message = CaptionLabel("")
        row_layout.addWidget(icon_label)
        row_layout.addWidget(message, stretch=1)
        return row, icon_label, message


__all__ = ["LabeledCombo", "PatternField"]
