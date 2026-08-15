# noqa: SIZE_OK - one module must own the whole Cache surface: the bilingual
# vocabulary, the readout model, the single-scroll readout, and the two
# read-only commands; splitting it would scatter one cohesive surface.

"""Read-only Cache work surface: effective paths, size, symlinks, free space.

DESIGN.md Section 4 fixes Cache as read-only inspection: effective HF_HOME,
HF_HUB_CACHE, and HF_XET_CACHE directories, hub-cache scan results, symlink
capability, and volume free space. Open Folder and Refresh are the only
commands; pruning and deletion are out of scope (drafts:29). All probes come
from the read-only diagnostics services and the surface's QScrollArea is its
single scroll owner (DESIGN.md 8.1).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.config.settings import Locale, Settings
from hubfetch.diagnostics.cache import (
    CacheEnvironment,
    HubCacheScan,
    resolve_cache_environment,
    scan_hub_cache,
)
from hubfetch.diagnostics.disk import VolumeInfo, volume_info
from hubfetch.diagnostics.filesystem import (
    DirectoryProbe,
    DirectorySize,
    directory_size,
    probe_directory,
)
from hubfetch.ui import fonts, icons, tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.common import apply_panel, semantic_colors
from hubfetch.ui.widgets.labels import CaptionLabel, ElidedLabel

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from pathlib import Path

__all__ = ["CacheReadout", "CacheView", "CacheViewTexts"]

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
class CacheViewTexts:
    """Bilingual vocabulary for the Cache surface, resolved by locale."""

    title: str
    hf_home_label: str
    hub_cache_label: str
    xet_cache_label: str
    hub_size_label: str
    repo_count_label: str
    incomplete_files_label: str
    corrupt_entries_label: str
    symlink_label: str
    free_space_label: str
    open_folder_command: str
    refresh_command: str
    symlink_ok: str
    symlink_degraded: str
    unknown_value: str

    @classmethod
    def for_locale(cls, locale: Locale) -> CacheViewTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return CacheViewTexts(
                title="Cache",
                hf_home_label="HF_HOME",
                hub_cache_label="HF_HUB_CACHE",
                xet_cache_label="HF_XET_CACHE",
                hub_size_label="Hub cache size",
                repo_count_label="Cached repositories",
                incomplete_files_label="Incomplete files",
                corrupt_entries_label="Corrupt entries",
                symlink_label="Symlink support",
                free_space_label="Volume free space",
                open_folder_command="Open Folder",
                refresh_command="Refresh",
                symlink_ok="Symlinks work on this volume",
                symlink_degraded="Symlinks degraded",
                unknown_value="Unknown",
            )
        return CacheViewTexts(
            title="缓存",
            hf_home_label="HF_HOME",
            hub_cache_label="HF_HUB_CACHE",
            xet_cache_label="HF_XET_CACHE",
            hub_size_label="Hub 缓存大小",
            repo_count_label="已缓存仓库",
            incomplete_files_label="未完成文件",
            corrupt_entries_label="损坏条目",
            symlink_label="符号链接支持",
            free_space_label="卷可用空间",
            open_folder_command="打开文件夹",
            refresh_command="刷新",
            symlink_ok="当前卷支持符号链接",
            symlink_degraded="符号链接能力受限",
            unknown_value="未知",
        )


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
class _CacheReadoutLabels:
    """The read-only value labels returned by the scroll builder."""

    hf_home: ElidedLabel
    hub_size: QLabel
    repo_count: QLabel
    incomplete: QLabel
    scan_error: QLabel
    symlink: QLabel
    volume: QLabel


def _open_local_folder(path: Path) -> bool:
    """Open a local directory in the system file explorer."""
    return QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))


@final
class CacheView(QWidget):
    """Inspect effective cache state with Open Folder and Refresh only."""

    __slots__: Final = (
        "_environ",
        "_open_folder",
        "_opener",
        "_readout",
        "_refresh",
        "_settings",
        "_texts",
        "_value_hf_home",
        "_value_hub_size",
        "_value_incomplete",
        "_value_repo_count",
        "_value_scan_error",
        "_value_symlink",
        "_value_volume",
    )
    _texts: CacheViewTexts
    _settings: Settings
    _environ: Mapping[str, str] | None
    _opener: Callable[[Path], bool]
    _open_folder: ActionButton
    _refresh: ActionButton
    _readout: CacheReadout | None
    _value_hf_home: ElidedLabel
    _value_hub_size: QLabel
    _value_repo_count: QLabel
    _value_incomplete: QLabel
    _value_scan_error: QLabel
    _value_symlink: QLabel
    _value_volume: QLabel

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
        self._opener = opener if opener is not None else _open_local_folder
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
        self._value_hf_home = labels.hf_home
        self._value_hub_size = labels.hub_size
        self._value_repo_count = labels.repo_count
        self._value_incomplete = labels.incomplete
        self._value_scan_error = labels.scan_error
        self._value_symlink = labels.symlink
        self._value_volume = labels.volume
        outer.addWidget(scroll, stretch=1)
        commands = self._build_commands()
        self._open_folder = commands[0]
        self._refresh = commands[1]
        outer.addLayout(self._command_row())
        colors = semantic_colors(self.palette())
        apply_panel(self, colors.border, colors.window)
        self._value_scan_error.setWordWrap(True)

    def _build_scroll(self) -> tuple[QScrollArea, _CacheReadoutLabels]:
        """Build the single scroll owner and return the readout labels."""
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setMinimumSize(0, 0)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        content = QWidget()
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(tokens.SPACE_SM)
        texts = self._texts
        hf_home = self._add_path_row(content_layout, texts.hf_home_label)
        _ = self._add_path_row(content_layout, texts.hub_cache_label)
        _ = self._add_path_row(content_layout, texts.xet_cache_label)
        hub_size = self._add_value_row(content_layout, texts.hub_size_label)
        repo_count = self._add_value_row(content_layout, texts.repo_count_label)
        incomplete = self._add_value_row(content_layout, texts.incomplete_files_label)
        scan_error = self._add_value_row(content_layout, texts.corrupt_entries_label)
        symlink = self._add_value_row(content_layout, texts.symlink_label)
        volume = self._add_value_row(content_layout, texts.free_space_label)
        content_layout.addStretch(1)
        scroll.setWidget(content)
        return scroll, _CacheReadoutLabels(
            hf_home=hf_home,
            hub_size=hub_size,
            repo_count=repo_count,
            incomplete=incomplete,
            scan_error=scan_error,
            symlink=symlink,
            volume=volume,
        )

    def _build_commands(self) -> tuple[ActionButton, ActionButton]:
        """Build the Open Folder and Refresh commands."""
        texts = self._texts
        open_folder = ActionButton(texts.open_folder_command)
        open_folder.setIcon(
            icons.icon(
                icons.IconName.FOLDER,
                self.palette().buttonText().color(),
                tokens.ICON_INLINE,
            )
        )
        refresh = ActionButton(texts.refresh_command)
        refresh.setIcon(
            icons.icon(
                icons.IconName.ROTATE_CW,
                self.palette().buttonText().color(),
                tokens.ICON_INLINE,
            )
        )
        _ = open_folder.clicked.connect(self.open_folder)
        _ = refresh.clicked.connect(self.refresh)
        return open_folder, refresh

    def _command_row(self) -> QHBoxLayout:
        """Compose the read-only command row in stable order."""
        commands = QHBoxLayout()
        commands.setSpacing(tokens.SPACE_SM)
        commands.addWidget(self._open_folder)
        commands.addWidget(self._refresh)
        commands.addStretch(1)
        return commands

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
        texts = self._texts
        self._value_hf_home.setText(str(readout.environment.hf_home))
        size = readout.hub_size
        self._value_hub_size.setText(
            format_bytes(size.bytes_total) if size is not None else texts.unknown_value
        )
        self._value_repo_count.setText(str(readout.hub_scan.repo_count))
        self._value_incomplete.setText(str(readout.hub_scan.incomplete_files))
        corrupt = readout.hub_scan.corrupt_entries
        self._value_scan_error.setText(
            "\n".join(corrupt) if corrupt else texts.unknown_value
        )
        probe = readout.hub_probe
        self._value_symlink.setText(
            texts.symlink_degraded
            if probe is not None and probe.symlink_degraded
            else texts.symlink_ok
        )
        volume = readout.volume
        self._value_volume.setText(format_bytes(volume.free_bytes))

    def _add_path_row(self, layout: QVBoxLayout, label_text: str) -> ElidedLabel:
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

    def _add_value_row(self, layout: QVBoxLayout, label_text: str) -> QLabel:
        """Add one key/value row and return its value label."""
        row = QHBoxLayout()
        row.setSpacing(tokens.SPACE_SM)
        row.addWidget(CaptionLabel(label_text))
        value = QLabel(self._texts.unknown_value)
        row.addWidget(value, stretch=1)
        layout.addLayout(row)
        return value
