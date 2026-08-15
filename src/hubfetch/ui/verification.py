"""Reproducible pixel verification for the showcase capture matrix.

Complements the manifest written by :mod:`hubfetch.ui.capture`: the on-disk
manifest is parsed back into the same :class:`CaptureEntry` records, every PNG
is re-hashed and dimension-checked, and each image is sampled into light/mid/
dark buckets that must match the captured theme (light canvas bright, dark
canvas dark, high-contrast black canvas with white foreground). Committing this
checker makes the visual-evidence verification reproducible by any later harness
run instead of relying on an ad-hoc script (DESIGN.md 12 visual QA gate).
"""

from __future__ import annotations

import hashlib
import json
import sys
from typing import TYPE_CHECKING, ClassVar, Final

from pydantic import BaseModel, ConfigDict, TypeAdapter
from PySide6.QtGui import QColor, QImage

from hubfetch.ui.manifest import MANIFEST_NAME, CaptureEntry

if TYPE_CHECKING:
    from pathlib import Path

_VERIFY_NAME: Final[str] = "capture-verify.json"
LIGHT_MIN: Final[int] = 240
"""Lightness above which a sampled pixel counts toward the light bucket."""

DARK_MAX: Final[int] = 60
"""Lightness below which a sampled pixel counts toward the dark bucket."""

_LIGHT_FLOOR: Final[float] = 0.55
"""Minimum light-bucket share for a light-theme capture."""

_DARK_FLOOR: Final[float] = 0.50
"""Minimum dark-bucket share for a dark-theme capture."""

_HC_DARK_FLOOR: Final[float] = 0.45
"""Minimum dark-bucket share for a high-contrast capture."""

_HC_LIGHT_FLOOR: Final[float] = 0.03
"""Minimum white-foreground share for a high-contrast capture."""


class _ManifestModel(BaseModel):
    """Typed schema mirroring the capture manifest written by ``run_matrix``."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)

    mode: str
    spec_count: int
    widths: list[int]
    scales: list[int]
    themes: list[str]
    entries: list[CaptureEntry]


_MANIFEST_ADAPTER: Final[TypeAdapter[_ManifestModel]] = TypeAdapter(_ManifestModel)


def _sample_buckets(image: QImage, step: int = 7) -> dict[str, int]:
    """Count light/mid/dark pixel buckets sampled every ``step`` pixels."""
    buckets: dict[str, int] = {}
    for y in range(0, image.height(), step):
        for x in range(0, image.width(), step):
            lightness = QColor.fromRgba(image.pixel(x, y)).lightness()
            if lightness < DARK_MAX:
                bucket = "dark"
            elif lightness > LIGHT_MIN:
                bucket = "light"
            else:
                bucket = "mid"
            buckets[bucket] = buckets.get(bucket, 0) + 1
    return buckets


def _theme_pixels_ok(theme: str, buckets: dict[str, int]) -> bool:
    """Return whether sampled buckets match the theme's expected balance."""
    total = max(1, sum(buckets.values()))
    dark_frac = buckets.get("dark", 0) / total
    light_frac = buckets.get("light", 0) / total
    match theme:
        case "light":
            return light_frac >= _LIGHT_FLOOR
        case "dark":
            return dark_frac >= _DARK_FLOOR
        case "high-contrast":
            return dark_frac >= _HC_DARK_FLOOR and light_frac >= _HC_LIGHT_FLOOR
        case _:
            return False


def _check_entry(entry: CaptureEntry, output_dir: Path) -> tuple[bool, dict[str, int]]:
    """Verify one PNG against its manifest entry; return ok and buckets."""
    problems: list[str] = []
    path = output_dir / entry.file
    if not path.is_file():
        sys.stdout.write(f"FAIL {entry.file}: missing PNG\n")
        return False, {}
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    image = QImage(str(path))
    buckets = _sample_buckets(image)
    if digest != entry.sha256:
        problems.append("sha256 mismatch")
    if image.width() != entry.pixel_width:
        problems.append("pixel_width mismatch")
    if image.height() != entry.pixel_height:
        problems.append("pixel_height mismatch")
    if not _theme_pixels_ok(entry.theme, buckets):
        problems.append("theme pixels out of range")
    if problems:
        sys.stdout.write(f"FAIL {entry.file}: {', '.join(problems)}\n")
        return False, buckets
    sys.stdout.write(f"PASS {entry.file}\n")
    return True, buckets


def verify_matrix(output_dir: Path) -> int:
    """Verify every capture against the manifest and theme pixel expectations.

    Writes ``capture-verify.json`` next to the manifest and returns zero only
    when every capture matches its recorded sha256, pixel dimensions, and theme
    bucket balance.
    """
    manifest = _MANIFEST_ADAPTER.validate_json(
        (output_dir / MANIFEST_NAME).read_text(encoding="utf-8")
    )
    failures = 0
    results: list[dict[str, object]] = []
    for entry in manifest.entries:
        ok, buckets = _check_entry(entry, output_dir)
        if not ok:
            failures += 1
        results.append({"file": entry.file, "ok": ok, "buckets": buckets})
    payload: dict[str, object] = {
        "verified": failures == 0,
        "failures": failures,
        "spec_count": manifest.spec_count,
        "results": results,
    }
    (output_dir / _VERIFY_NAME).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    sys.stdout.write(
        f"verified {len(manifest.entries)} captures, {failures} failure(s)\n"
    )
    return 0 if failures == 0 else 1


__all__ = ["DARK_MAX", "LIGHT_MIN", "verify_matrix"]
