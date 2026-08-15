"""Segmented control for mutually exclusive mode choices.

A segmented control is a row of checkable text segments inside one bordered
track (DESIGN.md 6.1). Selection is exclusive, signalled by ``currentChanged``,
and every segment is independently keyboard-focusable so the control is fully
operable without a pointer.
"""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QButtonGroup, QHBoxLayout, QPushButton, QWidget

from hubfetch.ui import focus, tokens
from hubfetch.ui.widgets import common


@dataclass(frozen=True, slots=True)
class Segment:
    """One selectable segment identified by a stable key and visible label."""

    key: str
    label: str


_SEGMENT_SHEET = (
    "QPushButton {{ {body} }}"
    "QPushButton:hover {{ {hover} }}"
    "QPushButton:checked {{ {checked} }}"
)


class SegmentedControl(QWidget):
    """An exclusive set of text segments emitting ``currentChanged(key)``."""

    currentChanged: Signal = Signal(str)  # noqa: N815 - Qt signal naming

    def __init__(self, accessible_name: str, segments: tuple[Segment, ...]) -> None:
        """Build one checkable button per segment inside a bordered track."""
        super().__init__()
        self._segments: dict[str, QPushButton] = {}
        self._current_key: str = segments[0].key if segments else ""
        self.setAccessibleName(accessible_name)
        self.setMinimumWidth(tokens.SEGMENTED_MIN_WIDTH)
        focus.make_focusable(self, accessible_name)
        self._group: QButtonGroup = QButtonGroup(self)
        self._group.setExclusive(True)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(2, 2, 2, 2)
        layout.setSpacing(2)
        for segment in segments:
            button = self._build_segment(segment)
            self._group.addButton(button)
            layout.addWidget(button, stretch=1)
            self._segments[segment.key] = button
        if self._current_key:
            self._segments[self._current_key].setChecked(True)
        self._group.buttonClicked.connect(self._on_segment_clicked)
        self.setStyleSheet(self._track_sheet())

    def segments(self) -> tuple[QPushButton, ...]:
        """Return the segment buttons in display order."""
        return tuple(self._segments.values())

    def first_segment(self) -> QPushButton:
        """Return the leading segment button (keyboard entry point)."""
        for button in self._segments.values():
            return button
        message = "segmented control was built without segments"
        raise ValueError(message)

    def current_key(self) -> str:
        """Return the selected segment key."""
        return self._current_key

    def set_current(self, key: str) -> None:
        """Select a segment by key and emit ``currentChanged`` on change."""
        button = self._segments[key]
        if self._current_key == key and button.isChecked():
            return
        button.setChecked(True)
        self._current_key = key
        self.currentChanged.emit(key)

    def _on_segment_clicked(self, button: QPushButton) -> None:
        for key, candidate in self._segments.items():
            if candidate is button and key != self._current_key:
                self._current_key = key
                self.currentChanged.emit(key)

    def _build_segment(self, segment: Segment) -> QPushButton:
        palette = self.palette()
        colors = common.semantic_colors(palette)
        tint = common.hover_tint(palette)
        button = QPushButton(segment.label)
        button.setCheckable(True)
        button.setFixedHeight(tokens.CONTROL_HEIGHT - 4)
        focus.make_focusable(button, segment.label)
        body = (
            f"background: transparent; border: none;"
            f" color: {palette.buttonText().color().name()};"
            f" border-radius: {tokens.RADIUS_CONTROL}px; padding: {tokens.SPACE_XS}px;"
        )
        hover = f"background-color: {tint};"
        checked = (
            f"background-color: {colors.surface};"
            f" border: 1px solid {colors.border}; font-weight: 600;"
        )
        button.setStyleSheet(
            _SEGMENT_SHEET.format(body=body, hover=hover, checked=checked)
        )
        return button

    def _track_sheet(self) -> str:
        colors = common.semantic_colors(self.palette())
        return (
            f"QWidget {{ background-color: {colors.window};"
            f" border: 1px solid {colors.border};"
            f" border-radius: {tokens.RADIUS_CONTROL}px; }}"
        )


__all__ = ["Segment", "SegmentedControl"]
