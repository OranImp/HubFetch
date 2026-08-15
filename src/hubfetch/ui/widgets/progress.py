"""Transfer progress bar with text-bearing captions.

The bar itself is a standard ``QProgressBar`` (accessible value exposed to
assistive APIs), and the numeric state is always duplicated as caption text so
progress stays readable without color or animation (DESIGN.md 7.2). Busy work
without a known total renders indeterminate while the caption keeps explaining
what is happening.
"""

from __future__ import annotations

from PySide6.QtWidgets import QHBoxLayout, QLabel, QProgressBar, QVBoxLayout, QWidget

from hubfetch.ui import tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.labels import CaptionLabel

_PERCENT_SCALE: int = 100


class TransferProgressBar(QWidget):
    """A 6 px bar plus caption reporting percent and transfer detail."""

    def __init__(self, label_text: str) -> None:
        """Build label, chunk-only bar, and caption row."""
        super().__init__()
        self._caption: CaptionLabel = CaptionLabel("")
        self._bar: QProgressBar = QProgressBar()
        self._bar.setRange(0, _PERCENT_SCALE)
        self._bar.setValue(0)
        self._bar.setTextVisible(False)
        self._bar.setFixedHeight(max(tokens.PROGRESS_HEIGHT, 8))
        self._bar.setAccessibleName(label_text)
        self.setAccessibleName(label_text)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_XS)
        caption_row = QHBoxLayout()
        caption_row.setSpacing(tokens.SPACE_XS)
        self._percent: QLabel = QLabel(f"{0}%")
        caption_row.addWidget(self._percent)
        caption_row.addWidget(self._caption, stretch=1)
        layout.addLayout(caption_row)
        layout.addWidget(self._bar)
        self._apply_bar_sheet()

    def bar(self) -> QProgressBar:
        """Expose the underlying progress bar."""
        return self._bar

    def set_progress(self, fraction: float, detail: str) -> None:
        """Show a bounded transfer as percent bar plus caption text."""
        clamped = min(max(fraction, 0.0), 1.0)
        percent = round(clamped * _PERCENT_SCALE)
        self._bar.setRange(0, _PERCENT_SCALE)
        self._bar.setValue(percent)
        self._percent.setText(f"{percent}%")
        self._caption.setText(detail)
        self._bar.setAccessibleDescription(f"{percent}% · {detail}")

    def set_busy(self, detail: str) -> None:
        """Show unbounded work as an indeterminate bar plus caption text."""
        self._bar.setRange(0, 0)
        self._percent.setText("")
        self._caption.setText(detail)
        self._bar.setAccessibleDescription(detail)

    def bar_value_percent(self) -> int:
        """Return the displayed percent value."""
        return self._bar.value()

    def caption_text(self) -> str:
        """Return the percent label plus caption as one readable string."""
        return f"{self._percent.text()} {self._caption.text()}".strip()

    def is_indeterminate(self) -> bool:
        """Return whether the bar shows unbounded work."""
        return self._bar.minimum() == 0 and self._bar.maximum() == 0

    def _apply_bar_sheet(self) -> None:
        palette = self.palette()
        colors = common.semantic_colors(palette)
        sheet = (
            "QProgressBar {"
            f" background-color: {colors.border};"
            " border: none;"
            f" border-radius: {max(tokens.PROGRESS_HEIGHT, 8) // 2}px;"
            " }"
            "QProgressBar::chunk {"
            f" background-color: {tokens.ACTION_BLUE};"
            f" border-radius: {max(tokens.PROGRESS_HEIGHT, 8) // 2}px;"
            " }"
        )
        self._bar.setStyleSheet(sheet)
        self._caption.setPalette(palette)


__all__ = ["TransferProgressBar"]
