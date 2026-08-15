"""Theme palette resolution and immediate application for Settings."""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from hubfetch.config.settings import Theme
from hubfetch.ui import style as ui_style

if TYPE_CHECKING:
    from PySide6.QtGui import QPalette

__all__ = ["apply_theme", "palette_for"]


def palette_for(theme: Theme) -> QPalette:
    """Resolve the locked light/dark/system palette for one theme choice."""
    app = QApplication.instance()
    if theme is Theme.SYSTEM and isinstance(app, QApplication):
        if app.styleHints().colorScheme() is Qt.ColorScheme.Dark:
            return ui_style.build_dark_palette()
        return ui_style.build_light_palette()
    if theme is Theme.LIGHT:
        return ui_style.build_light_palette()
    return ui_style.build_dark_palette()


def apply_theme(theme: Theme) -> None:
    """Apply one theme to the whole application palette immediately."""
    app = QApplication.instance()
    if isinstance(app, QApplication):
        app.setPalette(palette_for(theme))
