"""Read-only cache readout rows: paths, size, symlinks, and free space.

Owns the byte formatter, the scroll owner that builds every key/value row, and
the render pass that pushes one typed readout into the value labels. The view
stores the returned label registry and calls back into this module to render.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.ui import fonts, tokens
from hubfetch.ui.widgets.labels import CaptionLabel, ElidedLabel

if TYPE_CHECKING:
    from hubfetch.diagnostics.cache import CacheEnvironment, HubCacheScan
    from hubfetch.diagnostics.disk import VolumeInfo
    from hubfetch.diagnostics.filesystem import DirectoryProbe, DirectorySize

    from .texts import CacheViewTexts

__all__ = [
    "CacheReadout",
    "CacheReadoutLabels",
    "build_scroll",
    "format_bytes",
    "render_readout",
]

_BINARY_UNITS: Final = (
    (1 << 40, "TiB"),
    (1 << 30, "GiB"),
    (1 << 20, "MiB"),
    (1 << 10, "KiB"),
)


def format_bytes(count: int | None) -> str:
    """Render a byte count in compact binary units, or "unknown" for None."""
    if count is None or count < 0:
        return "unknown"
    for scale, suffix in _BINARY_UNITS:
        if count >= scale:
            return f"{count / scale:.1f} {suffix}"
    return f"{count} B"


@dataclass(frozen=True, slots=True)
class CacheReadout:
    """Typed result of one read-only cache inspection."""

    environment: CacheEnvironment
    hub_scan: HubCacheScan
    hub_probe: DirectoryProbe | None
    hub_size: DirectorySize | None
    volume: VolumeInfo
    refreshed_at: str


@dataclass(frozen=True, slots=True)
class CacheReadoutLabels:
    """The read-only value labels returned by the scroll builder."""

    hf_home: ElidedLabel
    hub_size: QLabel
    repo_count: QLabel
    incomplete: QLabel
    scan_error: QLabel
    symlink: QLabel
    volume: QLabel


def build_scroll(
    parent: QWidget, texts: CacheViewTexts
) -> tuple[QScrollArea, CacheReadoutLabels]:
    """Build the single scroll owner and return the readout labels."""
    scroll = QScrollArea(parent)
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.Shape.NoFrame)
    scroll.setMinimumSize(0, 0)
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
    content = QWidget()
    content_layout = QVBoxLayout(content)
    content_layout.setContentsMargins(0, 0, 0, 0)
    content_layout.setSpacing(tokens.SPACE_SM)
    hf_home = add_path_row(content_layout, texts.hf_home_label)
    _ = add_path_row(content_layout, texts.hub_cache_label)
    _ = add_path_row(content_layout, texts.xet_cache_label)
    hub_size = add_value_row(content_layout, texts, texts.hub_size_label)
    repo_count = add_value_row(content_layout, texts, texts.repo_count_label)
    incomplete = add_value_row(content_layout, texts, texts.incomplete_files_label)
    scan_error = add_value_row(content_layout, texts, texts.corrupt_entries_label)
    scan_error.setWordWrap(True)
    symlink = add_value_row(content_layout, texts, texts.symlink_label)
    volume = add_value_row(content_layout, texts, texts.free_space_label)
    content_layout.addStretch(1)
    scroll.setWidget(content)
    return scroll, CacheReadoutLabels(
        hf_home=hf_home,
        hub_size=hub_size,
        repo_count=repo_count,
        incomplete=incomplete,
        scan_error=scan_error,
        symlink=symlink,
        volume=volume,
    )


def render_readout(
    labels: CacheReadoutLabels, texts: CacheViewTexts, readout: CacheReadout
) -> None:
    """Push the typed readout into the read-only labels."""
    labels.hf_home.setText(str(readout.environment.hf_home))
    size = readout.hub_size
    labels.hub_size.setText(
        format_bytes(size.bytes_total) if size is not None else texts.unknown_value
    )
    labels.repo_count.setText(str(readout.hub_scan.repo_count))
    labels.incomplete.setText(str(readout.hub_scan.incomplete_files))
    corrupt = readout.hub_scan.corrupt_entries
    labels.scan_error.setText("\n".join(corrupt) if corrupt else texts.unknown_value)
    probe = readout.hub_probe
    labels.symlink.setText(
        texts.symlink_degraded
        if probe is not None and probe.symlink_degraded
        else texts.symlink_ok
    )
    labels.volume.setText(format_bytes(readout.volume.free_bytes))


def add_path_row(layout: QVBoxLayout, label_text: str) -> ElidedLabel:
    """Add one mono-font path row and return its value label."""
    row = QHBoxLayout()
    row.setSpacing(tokens.SPACE_SM)
    row.addWidget(CaptionLabel(label_text))
    value = ElidedLabel("")
    value.setFont(fonts.mono_font(tokens.CAPTION_SIZE))
    value.setAccessibleName(label_text)
    row.addWidget(value, stretch=1)
    layout.addLayout(row)
    return value


def add_value_row(
    layout: QVBoxLayout, texts: CacheViewTexts, label_text: str
) -> QLabel:
    """Add one key/value row and return its value label."""
    row = QHBoxLayout()
    row.setSpacing(tokens.SPACE_SM)
    row.addWidget(CaptionLabel(label_text))
    value = QLabel(texts.unknown_value)
    row.addWidget(value, stretch=1)
    layout.addLayout(row)
    return value
