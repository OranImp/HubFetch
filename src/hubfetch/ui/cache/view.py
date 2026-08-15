"""Read-only Cache work surface: effective paths, size, symlinks, free space.

DESIGN.md Section 4 fixes Cache as read-only inspection: effective HF_HOME,
HF_HUB_CACHE, and HF_XET_CACHE directories, hub-cache scan results, symlink
capability, and volume free space. Open Folder and Refresh are the only
commands; pruning and deletion are out of scope (drafts:29). The page owns the
readout state and command wiring; the scroll/rows live in :mod:`.rows` and the
commands in :mod:`.actions`. This module re-exports the surface's public
contract.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, final

from PySide6.QtWidgets import QHBoxLayout, QLabel, QScrollArea, QVBoxLayout, QWidget

from hubfetch.diagnostics.cache import (
    resolve_cache_environment,
    scan_hub_cache,
)
from hubfetch.diagnostics.disk import volume_info
from hubfetch.diagnostics.filesystem import (
    directory_size,
    probe_directory,
)
from hubfetch.ui import tokens
from hubfetch.ui.widgets.common import apply_panel, semantic_colors

from . import actions, rows
from .rows import CacheReadout, format_bytes
from .texts import CacheViewTexts

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from pathlib import Path

    from hubfetch.config.settings import Settings
    from hubfetch.ui.widgets.buttons import ActionButton

__all__ = ["CacheReadout", "CacheView", "CacheViewTexts", "format_bytes"]


@final
class CacheView(QWidget):
    """Inspect effective cache state with Open Folder and Refresh only."""

    __slots__: Final = (
        "_environ",
        "_labels",
        "_open_folder",
        "_opener",
        "_readout",
        "_refresh",
        "_settings",
        "_texts",
    )
    _texts: CacheViewTexts
    _settings: Settings
    _environ: Mapping[str, str] | None
    _opener: Callable[[Path], bool]
    _open_folder: ActionButton
    _refresh: ActionButton
    _readout: CacheReadout | None
    _labels: rows.CacheReadoutLabels

    def __init__(
        self,
        texts: CacheViewTexts,
        *,
        settings: Settings,
        environ: Mapping[str, str] | None = None,
        opener: Callable[[Path], bool] | None = None,
    ) -> None:
        """Compose the single-scroll readout and the two read-only commands."""
        super().__init__()
        self._texts = texts
        self._settings = settings
        self._environ = environ
        self._opener = opener if opener is not None else actions.open_local_folder
        self._readout = None
        self.setAccessibleName(texts.title)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        outer.setSpacing(tokens.SPACE_MD)
        title = QLabel(texts.title)
        title_font = title.font()
        title_font.setBold(True)
        title.setFont(title_font)
        outer.addWidget(title)
        scroll, labels = self._build_scroll()
        self._labels = labels
        outer.addWidget(scroll, stretch=1)
        self._open_folder, self._refresh = self._build_commands()
        outer.addLayout(self._command_row())
        colors = semantic_colors(self.palette())
        apply_panel(self, colors.border, colors.window)

    def _build_scroll(self) -> tuple[QScrollArea, rows.CacheReadoutLabels]:
        """Build the single scroll owner and return the readout labels."""
        return rows.build_scroll(self, self._texts)

    def _build_commands(self) -> tuple[ActionButton, ActionButton]:
        """Build the Open Folder and Refresh commands."""
        return actions.build_commands(self, self._texts, self.open_folder, self.refresh)

    def _command_row(self) -> QHBoxLayout:
        """Compose the read-only command row in stable order."""
        return actions.command_row(self._open_folder, self._refresh)

    def refresh(self) -> CacheReadout:
        """Re-run every read-only probe and render the typed readout."""
        environment = resolve_cache_environment(
            environ=self._environ, overrides=self._settings.cache_path_overrides
        )
        hub_scan = scan_hub_cache(environment.hub_cache)
        hub_probe = probe_directory(environment.hub_cache)
        hub_size = (
            directory_size(environment.hub_cache)
            if environment.hub_cache.is_dir()
            else None
        )
        readout = CacheReadout(
            environment=environment,
            hub_scan=hub_scan,
            hub_probe=hub_probe,
            hub_size=hub_size,
            volume=volume_info(environment.hub_cache),
            refreshed_at=datetime.now(UTC).isoformat(),
        )
        self._readout = readout
        self._render(readout)
        return readout

    def readout(self) -> CacheReadout | None:
        """Return the latest typed readout, or None before the first refresh."""
        return self._readout

    def open_folder(self) -> bool:
        """Open the effective hub cache in Explorer when it exists."""
        readout = self._readout
        if readout is None:
            return False
        target = readout.environment.hub_cache
        if not target.is_dir():
            return False
        return self._opener(target)

    def open_folder_button(self) -> ActionButton:
        """Return the Open Folder command."""
        return self._open_folder

    def refresh_button(self) -> ActionButton:
        """Return the Refresh command."""
        return self._refresh

    def _render(self, readout: CacheReadout) -> None:
        """Push the typed readout into the read-only labels."""
        rows.render_readout(self._labels, self._texts, readout)
