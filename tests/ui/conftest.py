"""Shared fixtures for desktop UI tests.

Selects the PySide6 binding, renders offscreen for determinism, and forces the
Fusion style so the explicit Transfer Ledger :mod:`QPalette` actually drives
widget colors (the native ``windowsvista`` style ignores application palettes
for many standard controls).
"""

from __future__ import annotations

import os

os.environ.setdefault("QT_API", "pyside6")
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest
from PySide6.QtWidgets import QApplication, QStyleFactory

import hubfetch.ui.style as ui_style


@pytest.fixture(autouse=True)
def transfer_ledger_style(qapp: QApplication) -> QApplication:
    """Apply the Fusion style and light palette so tokens control rendering."""
    style = QStyleFactory.create(ui_style.SHOWCASE_STYLE)
    assert style is not None
    qapp.setStyle(style)
    qapp.setPalette(ui_style.build_light_palette())
    return qapp
