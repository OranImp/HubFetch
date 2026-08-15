"""Palette builders mapping design tokens onto ``QPalette`` roles.

Light is locked to the six DESIGN.md hex tokens (Section 5.1). Dark and
high-contrast variants derive their semantic colors from Qt color roles
(Window/Base/Text/Highlight/Button) with secondary roles computed by lightness
transformation of the locked tokens, rather than recoloring the six light
values one for one (DESIGN.md Sections 5.1 and 9). The Fusion style is used for
the showcase because the native ``windowsvista`` style ignores application
palettes for many standard controls, which would hide the locked tokens.
"""

from __future__ import annotations

from enum import StrEnum, unique
from typing import Final, assert_never

from PySide6.QtGui import QColor, QPalette

from . import tokens

SHOWCASE_STYLE: Final[str] = "Fusion"
"""Style key that honors application ``QPalette`` for every standard control."""

_ACTIVE_GROUPS: Final = (QPalette.ColorGroup.Active, QPalette.ColorGroup.Inactive)


@unique
class Theme(StrEnum):
    """Closed visual themes the primitives must render under."""

    LIGHT = "light"
    DARK = "dark"
    HIGH_CONTRAST = "high-contrast"


def _lightness(color: QColor, value: float) -> QColor:
    """Return ``color`` re-expressed at a fixed HSL lightness.

    Hue and saturation are preserved so derived dark and high-contrast surfaces
    stay related to their locked source token instead of becoming arbitrary new
    hex values.
    """
    hue = max(color.hslHueF(), 0.0)
    saturation = color.hslSaturationF()
    alpha = color.alphaF()
    return QColor.fromHslF(hue, saturation, value, alpha)


def _set(palette: QPalette, role: QPalette.ColorRole, color: QColor) -> None:
    """Assign ``color`` to ``role`` for every enabled color group."""
    for group in _ACTIVE_GROUPS:
        palette.setColor(group, role, color)


def build_light_palette() -> QPalette:
    """Map the six locked light tokens onto semantic ``QPalette`` roles."""
    palette = QPalette()
    _set(palette, QPalette.ColorRole.Window, tokens.CANVAS_COLOR)
    _set(palette, QPalette.ColorRole.Base, tokens.SURFACE_COLOR)
    _set(palette, QPalette.ColorRole.AlternateBase, tokens.CANVAS_COLOR)
    _set(palette, QPalette.ColorRole.Text, tokens.INK_COLOR)
    _set(palette, QPalette.ColorRole.WindowText, tokens.INK_COLOR)
    _set(palette, QPalette.ColorRole.Button, tokens.SURFACE_COLOR)
    _set(palette, QPalette.ColorRole.ButtonText, tokens.INK_COLOR)
    _set(palette, QPalette.ColorRole.Highlight, tokens.ACTION_BLUE_COLOR)
    _set(palette, QPalette.ColorRole.HighlightedText, tokens.SURFACE_COLOR)
    _set(palette, QPalette.ColorRole.Link, tokens.ACTION_BLUE_COLOR)
    _set(palette, QPalette.ColorRole.LinkVisited, tokens.ACTION_BLUE_COLOR)
    _set(palette, QPalette.ColorRole.Mid, tokens.LINE_COLOR)
    _set(palette, QPalette.ColorRole.Light, tokens.SURFACE_COLOR)
    _set(palette, QPalette.ColorRole.Dark, _lightness(tokens.LINE_COLOR, 0.55))
    _set(palette, QPalette.ColorRole.Shadow, _lightness(tokens.INK_COLOR, 0.35))
    _set(
        palette, QPalette.ColorRole.PlaceholderText, _lightness(tokens.INK_COLOR, 0.45)
    )
    _set(palette, QPalette.ColorRole.ToolTipBase, tokens.SURFACE_COLOR)
    _set(palette, QPalette.ColorRole.ToolTipText, tokens.INK_COLOR)
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.Text,
        _lightness(tokens.INK_COLOR, 0.62),
    )
    return palette


def build_dark_palette() -> QPalette:
    """Derive a dark theme from Qt Window/Base/Text/Highlight/Button roles.

    Base roles are seeded by darkening the locked canvas/surface/ink tokens and
    secondary roles follow from those seeds, so the result reads as a system
    dark mapping rather than a one-note recolor of the light palette.
    """
    palette = QPalette()
    window = _lightness(tokens.CANVAS_COLOR, 0.13)
    base = _lightness(tokens.SURFACE_COLOR, 0.16)
    text = _lightness(tokens.INK_COLOR, 0.92)
    button = _lightness(tokens.CANVAS_COLOR, 0.18)
    border = _lightness(tokens.LINE_COLOR, 0.29)
    _set(palette, QPalette.ColorRole.Window, window)
    _set(palette, QPalette.ColorRole.Base, base)
    _set(palette, QPalette.ColorRole.AlternateBase, _lightness(base, 0.20))
    _set(palette, QPalette.ColorRole.Text, text)
    _set(palette, QPalette.ColorRole.WindowText, text)
    _set(palette, QPalette.ColorRole.Button, button)
    _set(palette, QPalette.ColorRole.ButtonText, text)
    _set(palette, QPalette.ColorRole.Highlight, tokens.ACTION_BLUE_COLOR)
    _set(palette, QPalette.ColorRole.HighlightedText, tokens.SURFACE_COLOR)
    _set(palette, QPalette.ColorRole.Link, _lightness(tokens.ACTION_BLUE_COLOR, 0.66))
    _set(
        palette,
        QPalette.ColorRole.LinkVisited,
        _lightness(tokens.ACTION_BLUE_COLOR, 0.60),
    )
    _set(palette, QPalette.ColorRole.Mid, border)
    _set(palette, QPalette.ColorRole.Light, button)
    _set(palette, QPalette.ColorRole.Dark, _lightness(window, 0.08))
    _set(palette, QPalette.ColorRole.Shadow, _lightness(window, 0.04))
    _set(palette, QPalette.ColorRole.PlaceholderText, _lightness(text, 0.55))
    _set(palette, QPalette.ColorRole.ToolTipBase, _lightness(base, 0.22))
    _set(palette, QPalette.ColorRole.ToolTipText, text)
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.Text,
        _lightness(text, 0.5),
    )
    return palette


def build_high_contrast_palette() -> QPalette:
    """Derive a high-contrast theme from the system high-contrast role poles.

    Surfaces take the neutral black extreme and text/borders the white extreme
    (the Windows high-contrast role poles, not the six brand tokens), with
    Signal Yellow marking link emphasis as a limited ecosystem cue paired with
    the Action Blue highlight so status never relies on color alone.
    """
    palette = QPalette()
    window = QColor("#000000")
    text = QColor("#ffffff")
    _set(palette, QPalette.ColorRole.Window, window)
    _set(palette, QPalette.ColorRole.Base, window)
    _set(palette, QPalette.ColorRole.AlternateBase, window)
    _set(palette, QPalette.ColorRole.Text, text)
    _set(palette, QPalette.ColorRole.WindowText, text)
    _set(palette, QPalette.ColorRole.Button, window)
    _set(palette, QPalette.ColorRole.ButtonText, text)
    _set(palette, QPalette.ColorRole.Highlight, tokens.ACTION_BLUE_COLOR)
    _set(palette, QPalette.ColorRole.HighlightedText, text)
    _set(palette, QPalette.ColorRole.Link, tokens.SIGNAL_YELLOW_COLOR)
    _set(palette, QPalette.ColorRole.LinkVisited, tokens.SIGNAL_YELLOW_COLOR)
    _set(palette, QPalette.ColorRole.Mid, text)
    _set(palette, QPalette.ColorRole.Light, text)
    _set(palette, QPalette.ColorRole.Dark, text)
    _set(palette, QPalette.ColorRole.Shadow, text)
    _set(palette, QPalette.ColorRole.PlaceholderText, _lightness(text, 0.72))
    _set(palette, QPalette.ColorRole.ToolTipBase, window)
    _set(palette, QPalette.ColorRole.ToolTipText, text)
    palette.setColor(
        QPalette.ColorGroup.Disabled,
        QPalette.ColorRole.Text,
        _lightness(text, 0.6),
    )
    return palette


def build_palette(theme: Theme) -> QPalette:
    """Return the palette for one theme with exhaustive dispatch."""
    match theme:
        case Theme.LIGHT:
            return build_light_palette()
        case Theme.DARK:
            return build_dark_palette()
        case Theme.HIGH_CONTRAST:
            return build_high_contrast_palette()
    assert_never(theme)


__all__ = [
    "SHOWCASE_STYLE",
    "Theme",
    "build_dark_palette",
    "build_high_contrast_palette",
    "build_light_palette",
    "build_palette",
]
