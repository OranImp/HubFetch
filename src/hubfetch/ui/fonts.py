"""Bundled Cascadia Mono registration and technical-text font construction.

Cascadia Mono ships under OFL 1.1 (see ``resources/fonts/OFL.txt``) and covers
the technical-data role (paths, revisions, speeds, log excerpts) per DESIGN.md
5.2. UI body text intentionally relies on the Windows-provided Segoe UI Variable /
Microsoft YaHei UI families and is not redistributed by HubFetch.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Final

from PySide6.QtGui import QFont, QFontDatabase

from . import tokens


def _resources_dir() -> Path:
    """Return the runtime resources root for the current deployment layout.

    The development layout resolves relative to the source tree; the packaged
    one-folder layout resolves against ``sys._MEIPASS`` so the resources the
    PyInstaller spec ships under ``resources/`` are found without a source
    checkout.
    """
    frozen = getattr(sys, "_MEIPASS", None)
    if isinstance(frozen, str):
        return Path(frozen).resolve()
    return Path(__file__).resolve().parents[3]


FONTS_DIR: Final[Path] = _resources_dir() / "resources" / "fonts"
"""Directory holding the bundled Cascadia Mono sources and their OFL license."""

_CASCADE_MONO_FILE: Final[str] = "CascadiaMono.ttf"


def register_bundled_fonts() -> tuple[str, ...]:
    """Register the bundled Cascadia Mono with Qt and return loaded families.

    A failed font load (missing or unreadable file) resolves to an empty tuple so
    callers degrade to the declared fallback family instead of raising; this is a
    documented resource boundary and never swallows a caller bug.
    """
    font_path = FONTS_DIR / _CASCADE_MONO_FILE
    font_id = QFontDatabase.addApplicationFont(str(font_path))
    if font_id == -1:
        return ()
    return tuple(QFontDatabase.applicationFontFamilies(font_id))


def mono_font(size: int = tokens.BODY_SIZE) -> QFont:
    """Return the technical-data font with a Consolas fallback chain."""
    font = QFont()
    font.setFamilies([tokens.MONO_FONT, tokens.MONO_FONT_FALLBACK])
    font.setStyleHint(QFont.StyleHint.Monospace)
    font.setPointSize(size)
    return font


def ui_font(size: int = tokens.BODY_SIZE) -> QFont:
    """Return the UI body font preferring Segoe UI Variable then YaHei UI.

    These families are provided by Windows and are not redistributed; the Latin
    family is tried first and the CJK family follows so Simplified Chinese labels
    resolve to Microsoft YaHei UI without explicit per-widget overrides.
    """
    font = QFont()
    font.setFamilies([tokens.LATIN_FONT, tokens.LATIN_FONT_FALLBACK, tokens.CJK_FONT])
    font.setPointSize(size)
    return font


__all__ = ["FONTS_DIR", "mono_font", "register_bundled_fonts", "ui_font"]
