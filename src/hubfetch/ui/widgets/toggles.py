"""Checkbox and toggle fields with description and inline error rows.

A field pairs its box with a caption description and a hidden error row. When
``set_error`` supplies a message the row appears with a triangle-alert icon
plus message text, so the invalid state is carried by shape and text, never by
color alone (DESIGN.md 3 and 6.2).
"""

from __future__ import annotations

from PySide6.QtWidgets import QCheckBox, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from hubfetch.ui import focus, icons, tokens
from hubfetch.ui.widgets.labels import CaptionLabel


class CheckboxField(QWidget):
    """A labeled checkbox with caption help and an optional error row."""

    def __init__(self, label: str, description: str) -> None:
        """Build box, help caption, and a hidden error row."""
        super().__init__()
        self._error_label: CaptionLabel | None = None
        self._error_icon: QLabel | None = None
        self._error_text: str | None = None
        self._box: QCheckBox = QCheckBox(label)
        focus.make_focusable(self._box, label)
        self._box.setAccessibleDescription(description)
        self.setAccessibleName(label)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_XS)
        layout.addWidget(self._box)
        if description:
            hint = CaptionLabel(description)
            layout.addWidget(hint)
        self._error_row: QWidget = self._build_error_row(layout)
        self._error_row.hide()

    def box(self) -> QCheckBox:
        """Expose the underlying checkbox for state assertions."""
        return self._box

    def error_text(self) -> str | None:
        """Return the currently displayed error message, if any."""
        return self._error_text

    def has_error_icon(self) -> bool:
        """Return whether the error row shows its triangle-alert glyph."""
        icon_label = self._error_icon
        return bool(
            icon_label is not None
            and not icon_label.pixmap().isNull()
            and not self._error_row.isHidden()
        )

    def set_error(self, message: str | None) -> None:
        """Show or clear the inline error row and store the message."""
        self._error_text = message
        if message is None:
            self._error_row.hide()
            self._box.setAccessibleDescription("")
            return
        icon_label = self._error_icon
        error_label = self._error_label
        if error_label is not None:
            error_label.setText(message)
        if icon_label is not None:
            icon_label.setPixmap(
                icons.icon(
                    icons.IconName.TRIANGLE_ALERT,
                    self.palette().text().color(),
                    tokens.ICON_INLINE,
                ).pixmap(tokens.ICON_INLINE, tokens.ICON_INLINE)
            )
        self._error_row.show()
        self._box.setAccessibleDescription(message)

    def _build_error_row(self, parent_layout: QVBoxLayout) -> QWidget:
        row = QWidget(self)
        row_layout = QHBoxLayout(row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(tokens.SPACE_XS)
        icon_label = QLabel()
        self._error_icon = icon_label
        row_layout.addWidget(icon_label)
        message = CaptionLabel("")
        self._error_label = message
        row_layout.addWidget(message, stretch=1)
        parent_layout.addWidget(row)
        return row


class ToggleField(CheckboxField):
    """A presentation of the checkbox field used for on/off preferences."""

    def __init__(self, label: str, description: str) -> None:
        """Mark the checkbox as a switch role for assistive technology."""
        super().__init__(label, description)
        self.box().setAccessibleName(f"{label}")
        self.box().setProperty("role", "switch")


__all__ = ["CheckboxField", "ToggleField"]
