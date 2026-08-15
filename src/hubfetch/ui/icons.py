"""Lucide-compatible SVG icon resource access.

Icons are the committed Lucide SVG sources under ``resources/icons`` (ISC
licensed, see ``resources/icons/LICENSE.md``). They use ``stroke=currentColor``
so a themed ``QColor`` substitutes the stroke before rasterization; this keeps
status and command icons readable in light, dark, and high-contrast palettes
without shipping pre-colored assets (DESIGN.md 5.6). Emoji, hand-drawn paths,
and the Hugging Face logo are prohibited by the contract and absent here.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from enum import StrEnum, unique
from pathlib import Path
from typing import Final, override

from PySide6.QtCore import QByteArray
from PySide6.QtGui import QColor, QIcon, QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer


def _resources_dir() -> Path:
    """Return the runtime resources root for the current deployment layout.

    The development layout resolves relative to the source tree; the packaged
    one-folder layout resolves against ``sys._MEIPASS`` so the Lucide SVGs the
    PyInstaller spec ships under ``resources/`` are found without a source
    checkout.
    """
    frozen = getattr(sys, "_MEIPASS", None)
    if isinstance(frozen, str):
        return Path(frozen).resolve()
    return Path(__file__).resolve().parents[3]


ICONS_DIR: Final[Path] = _resources_dir() / "resources" / "icons"
"""Directory holding the committed Lucide SVG sources and their license."""


@unique
class IconName(StrEnum):
    """Closed set of bundled Lucide icon resources.

    Every member's value is the SVG file stem under ``ICONS_DIR``; a missing
    file is a typed :class:`IconLoadError` rather than a silent blank icon.
    """

    ACTIVITY = "activity"
    ARROW_LEFT = "arrow-left"
    CHECK = "check"
    CHEVRON_DOWN = "chevron-down"
    CIRCLE_ALERT = "circle-alert"
    CIRCLE_CHECK = "circle-check"
    CIRCLE_PAUSE = "circle-pause"
    CIRCLE_X = "circle-x"
    CLOCK = "clock"
    DATABASE = "database"
    DOWNLOAD = "download"
    FILE = "file"
    FOLDER = "folder"
    GIT_BRANCH = "git-branch"
    GLOBE = "globe"
    INBOX = "inbox"
    INFO = "info"
    LIST_TODO = "list-todo"
    LOADER_CIRCLE = "loader-circle"
    LOCK = "lock"
    PLAY = "play"
    PLUS = "plus"
    ROTATE_CW = "rotate-cw"
    SETTINGS = "settings"
    SHIELD = "shield"
    SQUARE_TERMINAL = "square-terminal"
    TRIANGLE_ALERT = "triangle-alert"
    X = "x"


@dataclass(frozen=True, slots=True)
class IconLoadError(ValueError):
    """An icon resource could not be loaded or rendered."""

    name: str
    reason: str

    @override
    def __str__(self) -> str:
        return f"icon resource {self.name!r} unusable: {self.reason}"


def icons_dir() -> Path:
    """Return the directory holding the committed Lucide SVG sources."""
    return ICONS_DIR


def icon_file_path(name: IconName) -> Path:
    """Return the absolute SVG file path for one icon name."""
    return ICONS_DIR / f"{name.value}.svg"


def _svg_stroke(color: QColor | str) -> str:
    """Normalize a themed color to the concrete hex stroke value."""
    return QColor(color).name()


def render_svg_file(path: Path, color: QColor | str, size: int) -> QPixmap:
    """Rasterize one SVG file with a themed stroke at an exact pixel size.

    A missing file, unreadable document, or invalid SVG raises
    :class:`IconLoadError` instead of producing an invisible icon, so broken
    resources fail loudly at the resource boundary.
    """
    if not path.is_file():
        raise IconLoadError(name=path.name, reason="SVG file is missing")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise IconLoadError(name=path.name, reason=str(error)) from error
    body = text.replace("currentColor", _svg_stroke(color)).encode("utf-8")
    renderer = QSvgRenderer(QByteArray(body))
    if not renderer.isValid():
        raise IconLoadError(name=path.name, reason="SVG document is not valid")
    pixmap = QPixmap(size, size)
    pixmap.fill(QColor(0, 0, 0, 0))
    painter = QPainter(pixmap)
    try:
        renderer.render(painter)
    finally:
        painter.end()
    return pixmap


def icon_pixmap(name: IconName, color: QColor | str, size: int) -> QPixmap:
    """Return one bundled Lucide icon as a themed ``size`` square pixmap."""
    return render_svg_file(icon_file_path(name), color, size)


def icon(name: IconName, color: QColor | str, size: int) -> QIcon:
    """Return one bundled Lucide icon as a themed ``QIcon``."""
    return QIcon(icon_pixmap(name, color, size))


__all__ = [
    "ICONS_DIR",
    "IconLoadError",
    "IconName",
    "icon",
    "icon_file_path",
    "icon_pixmap",
    "icons_dir",
    "render_svg_file",
]
