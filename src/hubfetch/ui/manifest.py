"""Typed capture-matrix records shared by the renderer and the verifier.

Kept free of rendering logic so :mod:`hubfetch.ui.capture` (renderer) and
:mod:`hubfetch.ui.verification` (pixel checker) can both depend on the same
records without an import cycle. One :class:`CaptureSpec` names one
deterministic showcase state; one :class:`CaptureEntry` is its manifest record.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from pathlib import Path

    from hubfetch.ui import style as ui_style

MANIFEST_NAME: Final[str] = "showcase-manifest.json"
"""Manifest file written beside the captured PNG matrix."""


@dataclass(frozen=True, slots=True)
class CaptureSpec:
    """One deterministic showcase capture configuration."""

    theme: ui_style.Theme
    width: int
    scale_percent: int
    reduced_motion: bool

    def png_name(self) -> str:
        """Return the stable PNG file name for this capture."""
        motion = "reduced" if self.reduced_motion else "full"
        return (
            f"showcase-{self.theme.value}-{self.width}px-"
            f"{self.scale_percent}pct-{motion}-motion.png"
        )


@dataclass(frozen=True, slots=True)
class CaptureEntry:
    """Manifest metadata for one rendered capture."""

    file: str
    theme: str
    width_effective: int
    scale_percent: int
    reduced_motion: bool
    pixel_width: int
    pixel_height: int
    sha256: str
    non_blank: bool


@dataclass(frozen=True, slots=True)
class CaptureReport:
    """The manifest path and entries produced by one capture run."""

    manifest_path: Path
    entries: tuple[CaptureEntry, ...]


__all__ = ["MANIFEST_NAME", "CaptureEntry", "CaptureReport", "CaptureSpec"]
