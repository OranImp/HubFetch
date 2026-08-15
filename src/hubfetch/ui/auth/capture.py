"""Full-state UI capture matrix for the localized auth surface.

Todo 28 requires the full locked screen/state matrix: the auth panel in every
ownership and browser-code state across all three themes, three breakpoint
widths, both scales, both locales, and reduced-motion variants. Rendering
happens offscreen onto device-pixel-ratio pixmaps so captures are reproducible;
the manifest records geometry, theme, locale, scale, motion, and hashes so the
visual QA gate can re-verify every PNG later. State fixtures live in
:mod:`fixtures`.
"""

from __future__ import annotations

import hashlib
import json
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from pydantic import TypeAdapter
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import QApplication

from hubfetch.config.settings import Locale
from hubfetch.ui import style as ui_style

from .fixtures import build_state_panel, states
from .manifest import ManifestModel, ManifestName
from .texts import AuthTexts

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

_MEDIUM_WIDTH: Final[int] = 960
_WIDTHS: Final[tuple[int, ...]] = (
    ui_style.tokens.BREAKPOINT_MEDIUM - 1,
    _MEDIUM_WIDTH,
    ui_style.tokens.BREAKPOINT_WIDE + 100,
)
_SCALES: Final[tuple[int, ...]] = (100, 200)

_PANEL_MIN_HEIGHT: Final[int] = 220

_ACCELERATOR_KEYS: Final[tuple[str, ...]] = (
    "Alt+S",
    "Alt+R",
    "Alt+D",
    "Alt+C",
    "Alt+E",
    "Alt+Y",
    "Alt+X",
)


@dataclass(frozen=True, slots=True)
class CaptureSpec:
    """One deterministic auth-surface capture configuration."""

    state: str
    theme: ui_style.Theme
    width: int
    scale_percent: int
    locale: Locale
    reduced_motion: bool

    def png_name(self) -> str:
        """Return the stable PNG file name for this capture."""
        motion = "reduced" if self.reduced_motion else "full"
        return (
            f"ui-{self.state}-{self.theme.value}-{self.width}px-"
            f"{self.scale_percent}pct-{self.locale.value}-{motion}.png"
        )


@dataclass(frozen=True, slots=True)
class CaptureEntry:
    """Manifest metadata for one rendered auth-surface capture."""

    file: str
    state: str
    theme: str
    width_effective: int
    scale_percent: int
    locale: str
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


def auth_matrix() -> tuple[CaptureSpec, ...]:
    """Return the full auth-state capture matrix.

    Every ownership/browser state is captured in every theme at every breakpoint
    width and both scales in both locales; the pending state additionally
    renders a reduced-motion variant so the visual QA gate covers motion.
    """
    specs: list[CaptureSpec] = []
    for state in states:
        for theme in (
            ui_style.Theme.LIGHT,
            ui_style.Theme.DARK,
            ui_style.Theme.HIGH_CONTRAST,
        ):
            for width in _WIDTHS:
                for scale in _SCALES:
                    specs.extend(
                        CaptureSpec(
                            state=state,
                            theme=theme,
                            width=width,
                            scale_percent=scale,
                            locale=locale,
                            reduced_motion=False,
                        )
                        for locale in (Locale.ZH_CN, Locale.EN_US)
                    )
    specs.append(
        CaptureSpec(
            state="pending",
            theme=ui_style.Theme.LIGHT,
            width=_WIDTHS[1],
            scale_percent=100,
            locale=Locale.ZH_CN,
            reduced_motion=True,
        )
    )
    return tuple(specs)


def run_matrix(output_dir: Path, specs: Sequence[CaptureSpec]) -> CaptureReport:
    """Render every spec to a themed PNG and write the ui-matrix manifest."""
    output_dir.mkdir(parents=True, exist_ok=True)
    app = QApplication.instance()
    if not isinstance(app, QApplication):
        message = "capture requires an existing QApplication"
        raise TypeError(message)
    entries = tuple(_render_capture(app, spec, output_dir) for spec in specs)
    payload: dict[str, object] = {
        "mode": "Full",
        "spec_count": len(entries),
        "states": sorted({entry.state for entry in entries}),
        "widths": sorted({entry.width_effective for entry in entries}),
        "scales": sorted({entry.scale_percent for entry in entries}),
        "themes": sorted({entry.theme for entry in entries}),
        "locales": sorted({entry.locale for entry in entries}),
        "entries": [_entry_payload(entry) for entry in entries],
    }
    manifest_path = output_dir / ManifestName
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return CaptureReport(manifest_path=manifest_path, entries=entries)


def _entry_payload(entry: CaptureEntry) -> dict[str, object]:
    """Return the manifest-recordable fields of one capture entry."""
    return {
        "file": entry.file,
        "state": entry.state,
        "theme": entry.theme,
        "width_effective": entry.width_effective,
        "scale_percent": entry.scale_percent,
        "locale": entry.locale,
        "reduced_motion": entry.reduced_motion,
        "pixel_width": entry.pixel_width,
        "pixel_height": entry.pixel_height,
        "sha256": entry.sha256,
        "non_blank": entry.non_blank,
    }


def _render_capture(
    app: QApplication, spec: CaptureSpec, output_dir: Path
) -> CaptureEntry:
    """Render one auth state into a themed, scaled PNG entry."""
    palette = ui_style.build_palette(spec.theme)
    app.setPalette(palette)
    texts = AuthTexts.for_locale(spec.locale)
    panel = build_state_panel(spec.state, texts)
    panel.setFixedWidth(spec.width)
    panel.show()
    panel.adjustSize()
    height = max(panel.height(), _PANEL_MIN_HEIGHT)
    panel.resize(spec.width, height)
    for button in panel.command_buttons():
        if button.isVisible():
            button.setEnabled(True)
    pixel_width = spec.width * spec.scale_percent // 100
    pixel_height = height * spec.scale_percent // 100
    pixmap = QPixmap(pixel_width, pixel_height)
    pixmap.setDevicePixelRatio(spec.scale_percent / 100)
    pixmap.fill(palette.window().color())
    panel.render(pixmap)
    image = pixmap.toImage()
    file_name = spec.png_name()
    path = output_dir / file_name
    if not image.save(str(path)):
        message = f"PNG capture failed for {file_name}"
        raise RuntimeError(message)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return CaptureEntry(
        file=file_name,
        state=spec.state,
        theme=spec.theme.value,
        width_effective=spec.width,
        scale_percent=spec.scale_percent,
        locale=spec.locale.value,
        reduced_motion=spec.reduced_motion,
        pixel_width=pixel_width,
        pixel_height=pixel_height,
        sha256=digest,
        non_blank=_is_non_blank(image),
    )


def _is_non_blank(image: QImage) -> bool:
    """Return whether the capture contains more than one distinct color."""
    step_x = max(1, image.width() // 48)
    step_y = max(1, image.height() // 48)
    seen: set[int] = set()
    for y in range(0, image.height(), step_y):
        for x in range(0, image.width(), step_x):
            seen.add(image.pixel(x, y))
            if len(seen) > 1:
                return True
    return len(seen) > 1


def verify_matrix(output_dir: Path) -> int:
    """Re-verify every PNG against its manifest record."""
    manifest = TypeAdapter(ManifestModel).validate_json(
        (output_dir / ManifestName).read_text(encoding="utf-8")
    )
    failures = 0
    for entry in manifest.entries:
        path = output_dir / entry.file
        problems: list[str] = []
        if not path.is_file():
            problems.append("missing")
        else:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            image = QImage(str(path))
            if digest != entry.sha256:
                problems.append("sha256")
            if image.width() != entry.pixel_width:
                problems.append("width")
            if image.height() != entry.pixel_height:
                problems.append("height")
        if problems:
            failures += 1
            sys.stdout.write(f"FAIL {entry.file}: {', '.join(problems)}\n")
    if failures:
        sys.stdout.write(f"verified with {failures} failure(s)\n")
        return 1
    sys.stdout.write(f"verified {len(manifest.entries)} captures, 0 failures\n")
    return 0
