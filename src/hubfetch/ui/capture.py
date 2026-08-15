"""Deterministic showcase capture matrix and PNG manifest writer.

DESIGN.md Sections 11/12: before product screens exist, a deterministic state
harness captures every theme at the three breakpoint widths and 100%/200%
scaling, including reduced-motion variants. Rendering happens offscreen onto a
device-pixel-ratio pixmap so captures are reproducible byte-for-byte; the
manifest records geometry, theme, and content hashes for visual QA gates.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Final

from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import QApplication

from hubfetch.ui import focus, fonts, showcase, tokens
from hubfetch.ui import style as ui_style
from hubfetch.ui.manifest import MANIFEST_NAME, CaptureEntry, CaptureReport, CaptureSpec
from hubfetch.ui.verification import verify_matrix

if TYPE_CHECKING:
    from collections.abc import Sequence

_MEDIUM_WIDTH: Final[int] = 960
_CAPTURE_WIDTHS: Final[tuple[int, ...]] = (
    tokens.BREAKPOINT_MEDIUM - 1,
    _MEDIUM_WIDTH,
    tokens.BREAKPOINT_WIDE + 100,
)
_CAPTURE_SCALES: Final[tuple[int, ...]] = (100, 200)


def showcase_matrix() -> tuple[CaptureSpec, ...]:
    """Return the full 24-combination capture matrix.

    Three themes times three breakpoint widths times two scales give eighteen
    captures, and the light theme repeats each width/scale under reduced motion
    for six more, covering every combination the visual QA gate requires.
    """
    specs: list[CaptureSpec] = []
    for width in _CAPTURE_WIDTHS:
        for scale in _CAPTURE_SCALES:
            specs.extend(
                CaptureSpec(
                    theme=theme, width=width, scale_percent=scale, reduced_motion=False
                )
                for theme in (
                    ui_style.Theme.LIGHT,
                    ui_style.Theme.DARK,
                    ui_style.Theme.HIGH_CONTRAST,
                )
            )
            specs.append(
                CaptureSpec(
                    theme=ui_style.Theme.LIGHT,
                    width=width,
                    scale_percent=scale,
                    reduced_motion=True,
                )
            )
    return tuple(specs)


def run_matrix(output_dir: Path, specs: Sequence[CaptureSpec]) -> CaptureReport:
    """Render every spec to a themed PNG and write the capture manifest."""
    output_dir.mkdir(parents=True, exist_ok=True)
    app = QApplication.instance()
    if not isinstance(app, QApplication):
        message = "capture requires an existing QApplication"
        raise TypeError(message)
    entries = tuple(_render_capture(app, spec, output_dir) for spec in specs)
    payload: dict[str, object] = {
        "mode": "Showcase",
        "spec_count": len(entries),
        "widths": sorted({entry.width_effective for entry in entries}),
        "scales": sorted({entry.scale_percent for entry in entries}),
        "themes": sorted({entry.theme for entry in entries}),
        "entries": [_entry_payload(entry) for entry in entries],
    }
    manifest_path = output_dir / MANIFEST_NAME
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return CaptureReport(manifest_path=manifest_path, entries=entries)


def _entry_payload(entry: CaptureEntry) -> dict[str, object]:
    """Return the manifest-recordable fields of one capture entry."""
    return {
        "file": entry.file,
        "theme": entry.theme,
        "width_effective": entry.width_effective,
        "scale_percent": entry.scale_percent,
        "reduced_motion": entry.reduced_motion,
        "pixel_width": entry.pixel_width,
        "pixel_height": entry.pixel_height,
        "sha256": entry.sha256,
        "non_blank": entry.non_blank,
    }


def _render_capture(
    app: QApplication, spec: CaptureSpec, output_dir: Path
) -> CaptureEntry:
    """Render one showcase state into a themed, scaled PNG entry."""
    palette = ui_style.build_palette(spec.theme)
    app.setPalette(palette)
    motion = (
        tokens.MotionPreference.REDUCED
        if spec.reduced_motion
        else tokens.MotionPreference.FULL
    )
    window = showcase.ShowcaseWindow(motion=motion)
    window.set_effective_width(spec.width)
    window.stabilize_for_capture()
    # Focus can only attach to a visible widget tree; the offscreen platform maps
    # the window without a physical display, so show before focusing so the demo
    # button really holds focus and paints its ring in the captured frame.
    window.show()
    window.demo_keyboard_focus()
    content = window.content_widget()
    content.setFixedWidth(spec.width)
    grid = content.layout()
    if grid is not None:
        grid.activate()
    if grid is not None and grid.hasHeightForWidth():
        height = grid.heightForWidth(spec.width)
    else:
        height = content.sizeHint().height()
    height = max(height, 480)
    content.resize(spec.width, height)
    if grid is not None:
        grid.activate()
    pixel_width = spec.width * spec.scale_percent // 100
    pixel_height = height * spec.scale_percent // 100
    pixmap = QPixmap(pixel_width, pixel_height)
    pixmap.setDevicePixelRatio(spec.scale_percent / 100)
    pixmap.fill(palette.window().color())
    content.render(pixmap)
    image = pixmap.toImage()
    file_name = spec.png_name()
    path = output_dir / file_name
    if not image.save(str(path)):
        message = f"PNG capture failed for {file_name}"
        raise RuntimeError(message)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return CaptureEntry(
        file=file_name,
        theme=spec.theme.value,
        width_effective=spec.width,
        scale_percent=spec.scale_percent,
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


def main(argv: Sequence[str] | None = None) -> int:
    """Capture the showcase matrix; invoked by scripts/capture_ui_states.ps1."""
    args = tuple(sys.argv[1:] if argv is None else argv)
    output: str | None = None
    mode = "Showcase"
    index = 0
    while index + 1 < len(args):
        if args[index] == "--output":
            output = args[index + 1]
            index += 2
        elif args[index] == "--mode":
            mode = args[index + 1]
            index += 2
        else:
            index += 1
    if mode != "Showcase" or output is None:
        usage = "usage: python -m hubfetch.ui.capture --mode Showcase --output <dir>\n"
        sys.stdout.write(usage)
        return 2
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication(["hubfetch-capture"])
    fonts.register_bundled_fonts()
    app.setStyle(ui_style.SHOWCASE_STYLE)
    focus.install_focus_ring(app.style())
    report = run_matrix(Path(output), showcase_matrix())
    sys.stdout.write(f"captured {len(report.entries)} showcase states\n")
    sys.stdout.write(f"manifest: {report.manifest_path}\n")
    return verify_matrix(Path(output))


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "MANIFEST_NAME",
    "CaptureEntry",
    "CaptureReport",
    "CaptureSpec",
    "main",
    "run_matrix",
    "showcase_matrix",
]
