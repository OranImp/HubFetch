"""Read-only widget rendering for the Diagnostics report.

Owns the single scroll owner holding every category panel, the per-category
panel rebuild on each Recheck, and the one entry row with its guidance lines.
The view keeps the panel registry; this module renders into it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.ui import tokens
from hubfetch.ui.widgets.common import apply_panel, semantic_colors
from hubfetch.ui.widgets.labels import CaptionLabel
from hubfetch.ui.widgets.status import StatusPair

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from .models import DiagnosticEntry, DiagnosticsReport
    from .texts import DiagnosticsViewTexts

__all__ = ["build_body", "render_report"]


def build_body(
    parent: QWidget,
    keys: Sequence[str],
) -> tuple[QScrollArea, dict[str, QFrame]]:
    """Build the single scroll owner and one panel per category key."""
    scroll = QScrollArea(parent)
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.Shape.NoFrame)
    scroll.setMinimumSize(0, 0)
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
    content = QWidget()
    content_layout = QVBoxLayout(content)
    content_layout.setContentsMargins(0, 0, 0, 0)
    content_layout.setSpacing(tokens.SPACE_MD)
    panels: dict[str, QFrame] = {}
    for key in keys:
        panel = build_category_panel(parent, key)
        panels[key] = panel
        content_layout.addWidget(panel)
    content_layout.addStretch(1)
    scroll.setWidget(content)
    return scroll, panels


def build_category_panel(parent: QWidget, key: str) -> QFrame:
    """Create one bordered category panel tagged with its key."""
    panel = QFrame(parent)
    panel.setFrameShape(QFrame.Shape.StyledPanel)
    layout = QVBoxLayout(panel)
    layout.setContentsMargins(
        tokens.SPACE_MD, tokens.SPACE_MD, tokens.SPACE_MD, tokens.SPACE_MD
    )
    layout.setSpacing(tokens.SPACE_SM)
    _ = panel.setProperty("category", key)
    colors = semantic_colors(panel.palette())
    apply_panel(panel, colors.border, colors.window)
    return panel


def render_report(
    panels: Mapping[str, QFrame],
    texts: DiagnosticsViewTexts,
    report: DiagnosticsReport,
) -> None:
    """Rebuild each category panel's rows from the typed report."""
    for category in report.categories:
        panel = panels[category.key]
        raw_layout = panel.layout()
        if not isinstance(raw_layout, QVBoxLayout):
            continue
        layout = raw_layout
        clear_layout(layout)
        title = QLabel(texts.category_titles[category.key])
        title_font = title.font()
        title_font.setWeight(QFont.Weight.DemiBold)
        title.setFont(title_font)
        layout.addWidget(title)
        for entry in category.entries:
            layout.addWidget(entry_row(panel, texts, entry))
        layout.addStretch(1)


def entry_row(
    parent: QWidget, texts: DiagnosticsViewTexts, entry: DiagnosticEntry
) -> QWidget:
    """Render one diagnostic entry with its guidance below the value."""
    row = QWidget(parent)
    layout = QVBoxLayout(row)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(tokens.SPACE_XS)
    headline = QHBoxLayout()
    headline.setSpacing(tokens.SPACE_SM)
    key = CaptionLabel(texts.entry_labels.get(entry.key, entry.key))
    headline.addWidget(key)
    headline.addStretch(1)
    pair = StatusPair(entry.severity, entry.value)
    pair.setAccessibleName(entry.value)
    headline.addWidget(pair)
    layout.addLayout(headline)
    for guidance in entry.guidance:
        hint = CaptionLabel(guidance)
        hint.setWordWrap(True)
        layout.addWidget(hint)
    return row


def clear_layout(layout: QVBoxLayout) -> None:
    """Remove every item and child widget from a category layout."""
    while layout.count():
        item = layout.takeAt(0)
        if item is None:
            continue
        widget = item.widget()
        if widget is not None:
            widget.deleteLater()
