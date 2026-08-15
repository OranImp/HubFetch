# noqa: SIZE_OK - one module must enumerate the full auth-state capture matrix
# contract: state coverage, theme/width/scale/locale/motion combinations,
# manifest writing, deterministic hashes, and non-blank PNGs.

"""Given/When/Then contracts for the Todo 28 full auth-state capture matrix.

The full matrix captures every auth ownership and browser-code state across all
three themes, three breakpoint widths, both scales, and both locales, plus a
reduced-motion variant, into ``ui-matrix-manifest.json`` and ``ui-*.png`` so
the visual QA gate can re-verify real native-desktop evidence.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from hubfetch.config.settings import Locale
from hubfetch.ui import style
from hubfetch.ui.auth import capture

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

WIDTHS = (759, 960, 1280)
THEMES = (style.Theme.LIGHT, style.Theme.DARK, style.Theme.HIGH_CONTRAST)
STATES = (
    "anonymous",
    "hubfetch_only",
    "shared",
    "pending",
    "expired",
    "denied",
    "cancelled",
    "unavailable",
    "token_entry",
    "confirm_delete",
)


def test_full_matrix_covers_every_required_state() -> None:
    """Given the full matrix, every locked auth state is represented."""
    matrix = capture.auth_matrix()
    covered = {spec.state for spec in matrix}
    assert covered == set(STATES)


def test_full_matrix_covers_every_theme_width_scale_locale() -> None:
    """Given the full matrix, every theme appears at every width and both
    scales in both locales."""
    matrix = capture.auth_matrix()
    for theme in THEMES:
        for width in WIDTHS:
            for scale in (100, 200):
                for locale in (Locale.ZH_CN, Locale.EN_US):
                    assert any(
                        spec.theme is theme
                        and spec.width == width
                        and spec.scale_percent == scale
                        and spec.locale is locale
                        for spec in matrix
                    ), f"{theme.value} {width}px {scale}% {locale.value}"


def test_full_matrix_includes_reduced_motion_variant() -> None:
    """Given the full matrix, the pending state also renders a reduced-motion
    variant so the visual QA gate covers motion."""
    assert any(
        spec.reduced_motion and spec.state == "pending"
        for spec in capture.auth_matrix()
    )


def test_full_matrix_has_unique_png_names() -> None:
    """Given the full matrix, every spec maps to a distinct PNG file."""
    matrix = capture.auth_matrix()
    names = {spec.png_name() for spec in matrix}
    assert len(names) == len(matrix)


def test_full_capture_writes_manifest_with_nonblank_pngs(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given the full matrix, capturing writes the ui manifest and every PNG is
    non-blank with the expected pixel dimensions."""
    _ = qtbot  # fixture guarantees a QApplication exists for offscreen rendering
    report = capture.run_matrix(tmp_path, capture.auth_matrix())
    assert report.manifest_path.name == "ui-matrix-manifest.json"
    assert report.manifest_path.is_file()
    for entry in report.entries:
        assert entry.non_blank, entry.file
        assert entry.pixel_width == entry.width_effective * entry.scale_percent // 100
        assert (tmp_path / entry.file).is_file()


def test_full_capture_is_deterministic_for_identical_spec(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given one spec, rendering twice produces byte-identical PNGs."""
    _ = qtbot  # fixture guarantees a QApplication exists for offscreen rendering
    spec = capture.CaptureSpec(
        state="pending",
        theme=style.Theme.LIGHT,
        width=960,
        scale_percent=100,
        locale=Locale.ZH_CN,
        reduced_motion=False,
    )
    first = capture.run_matrix(tmp_path / "run-a", (spec,))
    second = capture.run_matrix(tmp_path / "run-b", (spec,))
    assert first.entries[0].sha256 == second.entries[0].sha256


def test_browser_outcome_states_render_distinctly(qtbot: QtBot, tmp_path: Path) -> None:
    """Given the four browser-code states, each renders a distinct PNG so the
    pending/expired/denied/cancelled states are never byte-identical."""
    _ = qtbot  # fixture guarantees a QApplication exists for offscreen rendering
    specs = tuple(
        capture.CaptureSpec(
            state=state,
            theme=style.Theme.LIGHT,
            width=960,
            scale_percent=100,
            locale=Locale.ZH_CN,
            reduced_motion=False,
        )
        for state in ("pending", "expired", "denied", "cancelled")
    )
    report = capture.run_matrix(tmp_path, specs)

    hashes = {entry.sha256 for entry in report.entries}
    assert len(hashes) == len(specs)
    assert all(entry.non_blank for entry in report.entries)


def test_full_verify_rejects_manifest_without_pngs(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a manifest pointing at a missing PNG, verification fails."""
    _ = qtbot  # fixture guarantees a QApplication exists for offscreen rendering
    _ = capture.run_matrix(tmp_path, (capture.auth_matrix()[0],))
    _ = (tmp_path / capture.auth_matrix()[0].png_name()).unlink()

    assert capture.verify_matrix(tmp_path) != 0
