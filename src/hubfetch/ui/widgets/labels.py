"""Caption and eliding labels for dense ledger rows.

Long repository identifiers, paths, and URLs must never break row geometry or
create horizontal scrolling (DESIGN.md 4 and 8). :class:`ElidedLabel` therefore
middle-elides its stored full text whenever the available width shrinks, and it
exposes the full text plus an elision flag for accessibility tests and screen
reader consumers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, override

from PySide6.QtCore import QEvent, Qt
from PySide6.QtWidgets import QLabel, QSizePolicy, QWidget

from hubfetch.ui import tokens

if TYPE_CHECKING:
    from PySide6.QtGui import QResizeEvent


class CaptionLabel(QLabel):
    """A 12/16 px secondary text label used for captions and hints."""

    def __init__(self, text: str = "", parent: QWidget | None = None) -> None:
        """Create a caption label with the locked caption point size."""
        super().__init__(text, parent)
        font = self.font()
        font.setPointSize(tokens.CAPTION_SIZE)
        self.setFont(font)


class ElidedLabel(QLabel):
    """A single-line label that middle-elides instead of overflowing.

    Middle elision keeps both the namespace prefix and the file suffix of long
    identifiers visible, which is how queue rows stay scannable under stress
    fixtures. The full unmodified text remains available through
    :meth:`full_text` and as the accessible name when the caller assigns one.
    """

    def __init__(self, text: str = "", parent: QWidget | None = None) -> None:
        """Store ``text`` as the full value and render an elided copy."""
        super().__init__(parent)
        self._full_text: str = text
        self._elide_mode: Qt.TextElideMode = Qt.TextElideMode.ElideMiddle
        self._elided: bool = False
        self.setMinimumWidth(0)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self._refresh()

    def full_text(self) -> str:
        """Return the unelided source text."""
        return self._full_text

    def elided(self) -> bool:
        """Return whether the visible text is currently shorter than the source."""
        return self._elided

    def set_elide_mode(self, mode: Qt.TextElideMode) -> None:
        """Change the elision strategy and re-render."""
        self._elide_mode = mode
        self._refresh()

    @override
    def setText(self, text: str) -> None:
        """Store ``text`` as the full value, then render an elided copy."""
        self._full_text = text
        self._refresh()

    @override
    def changeEvent(self, event: QEvent) -> None:
        """Re-elide when the font or palette changes."""
        super().changeEvent(event)
        if event.type() == QEvent.Type.FontChange:
            self._refresh()

    @override
    def resizeEvent(self, event: QResizeEvent) -> None:
        """Re-elide whenever the available width changes."""
        super().resizeEvent(event)
        self._refresh()

    def _refresh(self) -> None:
        """Compute the elided rendering for the current width and font."""
        metrics = self.fontMetrics()
        available = max(0, self.width() - 2)
        if available <= 0:
            super().setText("")
            self._elided = bool(self._full_text)
            return
        fits = metrics.horizontalAdvance(self._full_text) <= available
        self._elided = not fits and bool(self._full_text)
        shown = (
            self._full_text
            if fits
            else metrics.elidedText(self._full_text, self._elide_mode, available)
        )
        super().setText(shown)


__all__ = ["CaptionLabel", "ElidedLabel"]
