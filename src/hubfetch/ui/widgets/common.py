"""Shared geometry and surface helpers for the Transfer Ledger primitives.

Borders are the only depth device (DESIGN.md 5.5): one pixel lines and rounded
corners never exceeding 8 px. Surface and border colors are always derived from
the active ``QPalette`` roles (DESIGN.md 9) rather than the locked light tokens,
so light, dark, and high-contrast themes render theme-correct neutrals while the
six tokens remain the light-theme seed values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from PySide6.QtGui import QColor, QPalette

from hubfetch.ui import tokens

if TYPE_CHECKING:
    from PySide6.QtWidgets import QWidget


@dataclass(frozen=True, slots=True)
class SemanticColors:
    """Theme-correct neutral colors resolved from ``QPalette`` roles."""

    border: str
    surface: str
    window: str
    text: str
    placeholder: str


def semantic_colors(palette: QPalette) -> SemanticColors:
    """Map palette roles to the neutral colors every sheet should use."""
    return SemanticColors(
        border=palette.color(QPalette.ColorRole.Mid).name(),
        surface=palette.color(QPalette.ColorRole.Base).name(),
        window=palette.color(QPalette.ColorRole.Window).name(),
        text=palette.color(QPalette.ColorRole.Text).name(),
        placeholder=palette.color(QPalette.ColorRole.PlaceholderText).name(),
    )


def hover_tint(palette: QPalette) -> str:
    """Return a low-alpha tint of the palette text color for hover/pressed.

    Deriving the interaction tint from the Text role keeps hover feedback
    visible in light, dark, and high-contrast themes without adding colors
    outside the palette (DESIGN.md 5.1, 9).
    """
    tint = QColor(palette.color(QPalette.ColorRole.Text))
    tint.setAlpha(28)
    return tint.name(QColor.NameFormat.HexArgb)


def border_sheet(border: str, radius: int, fill: str | None = None) -> str:
    """Assemble a one-pixel border sheet with a capped radius and optional fill."""
    capped = min(radius, tokens.RADIUS_PANEL)
    sheet = f"border: 1px solid {border}; border-radius: {capped}px;"
    if fill is not None:
        sheet += f" background-color: {fill};"
    return sheet


def apply_panel(
    widget: QWidget,
    border: str,
    fill: str | None = None,
    radius: int = tokens.RADIUS_PANEL,
) -> None:
    """Style a container as a flat bordered panel one level deep."""
    widget.setStyleSheet(border_sheet(border, radius, fill))


def apply_control(
    widget: QWidget,
    border: str,
    fill: str | None = None,
    radius: int = tokens.RADIUS_CONTROL,
    padding: int = tokens.SPACE_SM,
) -> None:
    """Style a compact control surface with 4 px radius and control padding."""
    sheet = border_sheet(border, radius, fill)
    widget.setStyleSheet(f"{sheet} padding: {padding}px;")


def caption_font_point_size() -> int:
    """Return the caption point size shared by labels and hints (12/16)."""
    return tokens.CAPTION_SIZE


__all__ = [
    "SemanticColors",
    "apply_control",
    "apply_panel",
    "border_sheet",
    "caption_font_point_size",
    "hover_tint",
    "semantic_colors",
]
