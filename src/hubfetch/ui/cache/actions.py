"""The two read-only Cache commands: Open Folder and Refresh.

Owns the desktop-opener seam, the command button factory with its icons, and
the stable command-row layout. The view wires the button signals to its own
``open_folder`` and ``refresh`` handlers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QHBoxLayout, QWidget

from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets.buttons import ActionButton

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from .texts import CacheViewTexts

__all__ = ["build_commands", "command_row", "open_local_folder"]


def open_local_folder(path: Path) -> bool:
    """Open a local directory in the system file explorer."""
    return QDesktopServices.openUrl(QUrl.fromLocalFile(str(path)))


def build_commands(
    parent: QWidget,
    texts: CacheViewTexts,
    on_open: Callable[[], object],
    on_refresh: Callable[[], object],
) -> tuple[ActionButton, ActionButton]:
    """Build the Open Folder and Refresh commands."""
    open_folder = ActionButton(texts.open_folder_command)
    open_folder.setIcon(
        icons.icon(
            icons.IconName.FOLDER,
            parent.palette().buttonText().color(),
            tokens.ICON_INLINE,
        )
    )
    refresh = ActionButton(texts.refresh_command)
    refresh.setIcon(
        icons.icon(
            icons.IconName.ROTATE_CW,
            parent.palette().buttonText().color(),
            tokens.ICON_INLINE,
        )
    )
    _ = open_folder.clicked.connect(on_open)
    _ = refresh.clicked.connect(on_refresh)
    return open_folder, refresh


def command_row(open_folder: ActionButton, refresh: ActionButton) -> QHBoxLayout:
    """Compose the read-only command row in stable order."""
    commands = QHBoxLayout()
    commands.setSpacing(tokens.SPACE_SM)
    commands.addWidget(open_folder)
    commands.addWidget(refresh)
    commands.addStretch(1)
    return commands
