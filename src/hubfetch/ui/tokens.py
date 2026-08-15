"""Design tokens for the Transfer Ledger design system (DESIGN.md Section 5).

Every value traces to the binding visual contract in ``DESIGN.md``. Only the six
locked light colors are fixed brand hex values; dark and high-contrast variants
derive from Qt color roles in :mod:`hubfetch.ui.style` rather than recoloring
these six values one for one (DESIGN.md 5.1 / 9). Tokens stay plain so geometry,
spacing, and motion contracts can be asserted without constructing widgets.
"""

from __future__ import annotations

from enum import StrEnum, unique
from typing import Final

from PySide6.QtGui import QColor

# --- 5.1 Color palette (locked light values) ------------------------------
INK: Final[str] = "#202124"
CANVAS: Final[str] = "#F7F8FA"
SURFACE: Final[str] = "#FFFFFF"
LINE: Final[str] = "#D9DEE7"
SIGNAL_YELLOW: Final[str] = "#FFD21E"
ACTION_BLUE: Final[str] = "#2563EB"

INK_COLOR: Final[QColor] = QColor(INK)
CANVAS_COLOR: Final[QColor] = QColor(CANVAS)
SURFACE_COLOR: Final[QColor] = QColor(SURFACE)
LINE_COLOR: Final[QColor] = QColor(LINE)
SIGNAL_YELLOW_COLOR: Final[QColor] = QColor(SIGNAL_YELLOW)
ACTION_BLUE_COLOR: Final[QColor] = QColor(ACTION_BLUE)


@unique
class MotionPreference(StrEnum):
    """Animation policy for the stage-rail pulse and loading spinners.

    ``REDUCED`` disables every pulse while keeping progress readable as static
    text and geometry (DESIGN.md 7.2).
    """

    FULL = "full"
    REDUCED = "reduced"


# --- 5.2 Typography --------------------------------------------------------
LATIN_FONT: Final[str] = "Segoe UI Variable"
LATIN_FONT_FALLBACK: Final[str] = "Segoe UI"
CJK_FONT: Final[str] = "Microsoft YaHei UI"
MONO_FONT: Final[str] = "Cascadia Mono"
MONO_FONT_FALLBACK: Final[str] = "Consolas"

BODY_SIZE: Final[int] = 14
BODY_LINE: Final[int] = 20
CAPTION_SIZE: Final[int] = 12
CAPTION_LINE: Final[int] = 16

# --- 5.3 Spacing (4 px base, 4/8 steps) ------------------------------------
SPACE_XS: Final[int] = 4
SPACE_SM: Final[int] = 8
SPACE_MD: Final[int] = 12
SPACE_LG: Final[int] = 16
SPACE_XL: Final[int] = 24
SPACE_XXL: Final[int] = 32

SPACING_SCALE: Final[tuple[int, ...]] = (
    SPACE_XS,
    SPACE_SM,
    SPACE_MD,
    SPACE_LG,
    SPACE_XL,
    SPACE_XXL,
)

SPACE_1: Final[int] = SPACE_XS
"""Single-step spacing alias kept for primitive call sites."""

# --- 5.4 Radii (never exceed 8 px) ------------------------------------------
RADIUS_CONTROL: Final[int] = 4
RADIUS_PANEL: Final[int] = 8

# --- 5.6 Icon policy sizes ---------------------------------------------------
ICON_INLINE: Final[int] = 16
ICON_COMMAND: Final[int] = 20

# --- Geometry contracts (fixed/min/max per primitive) ------------------------
CONTROL_HEIGHT: Final[int] = 32
NAV_ITEM_HEIGHT: Final[int] = 40
TASK_ROW_HEIGHT: Final[int] = 56
BUTTON_MIN_WIDTH: Final[int] = 96
FIELD_MIN_WIDTH: Final[int] = 240
FIELD_MAX_WIDTH: Final[int] = 640
SEGMENTED_MIN_WIDTH: Final[int] = 200
RAIL_MIN_WIDTH: Final[int] = 240
TASK_LIST_WIDTH: Final[int] = 360
PROGRESS_HEIGHT: Final[int] = 6

# --- 8.2 Breakpoints (effective device-independent pixels) -------------------
BREAKPOINT_MEDIUM: Final[int] = 760
BREAKPOINT_WIDE: Final[int] = 1180

# --- 7 Motion timing -----------------------------------------------------------
FEEDBACK_MIN_MS: Final[int] = 83
FEEDBACK_MAX_MS: Final[int] = 167
ACTIVE_PULSE_MS: Final[int] = 120

__all__ = [
    "ACTION_BLUE",
    "ACTION_BLUE_COLOR",
    "ACTIVE_PULSE_MS",
    "BODY_LINE",
    "BODY_SIZE",
    "BREAKPOINT_MEDIUM",
    "BREAKPOINT_WIDE",
    "BUTTON_MIN_WIDTH",
    "CANVAS",
    "CANVAS_COLOR",
    "CAPTION_LINE",
    "CAPTION_SIZE",
    "CJK_FONT",
    "CONTROL_HEIGHT",
    "FEEDBACK_MAX_MS",
    "FEEDBACK_MIN_MS",
    "FIELD_MAX_WIDTH",
    "FIELD_MIN_WIDTH",
    "ICON_COMMAND",
    "ICON_INLINE",
    "INK",
    "INK_COLOR",
    "LATIN_FONT",
    "LATIN_FONT_FALLBACK",
    "LINE",
    "LINE_COLOR",
    "MONO_FONT",
    "MONO_FONT_FALLBACK",
    "NAV_ITEM_HEIGHT",
    "PROGRESS_HEIGHT",
    "RADIUS_CONTROL",
    "RADIUS_PANEL",
    "RAIL_MIN_WIDTH",
    "SEGMENTED_MIN_WIDTH",
    "SIGNAL_YELLOW",
    "SIGNAL_YELLOW_COLOR",
    "SPACE_1",
    "SPACE_LG",
    "SPACE_MD",
    "SPACE_SM",
    "SPACE_XL",
    "SPACE_XS",
    "SPACE_XXL",
    "SPACING_SCALE",
    "SURFACE",
    "SURFACE_COLOR",
    "TASK_LIST_WIDTH",
    "TASK_ROW_HEIGHT",
    "MotionPreference",
]
