"""Standalone deterministic showcase rendering every primitive in every state.

DESIGN.md Section 11: the showcase exercises each primitive and state before
product screens are composed. The window reflows by effective width exactly as
the shell will (one pane below 760 px, two columns at 760-1179, three at 1180
and above), and :func:`is_showcase_request` gives the later application entry a
stable ``--showcase`` hook (DESIGN.md 14 handoff). Section content lives in
:mod:`hubfetch.ui.showcase_sections` so this module stays a thin shell.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication,
    QGridLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.ui import fixtures, focus, fonts, showcase_sections, tokens
from hubfetch.ui import style as ui_style
from hubfetch.ui.widgets.common import apply_panel, semantic_colors

if TYPE_CHECKING:
    from collections.abc import Sequence

    from hubfetch.ui.widgets.blocks import LoadingBlock
    from hubfetch.ui.widgets.stage_rail import TransferStageRail

SHOWCASE_FLAG: Final[str] = "--showcase"
_MIN_CAPTURE_HEIGHT: Final[int] = 480


def is_showcase_request(argv: Sequence[str]) -> bool:
    """Return whether the process arguments ask for the showcase mode."""
    return SHOWCASE_FLAG in tuple(argv)


def _columns_for_width(width: int) -> int:
    """Return the responsive column count for one effective width."""
    medium = tokens.BREAKPOINT_MEDIUM
    wide = tokens.BREAKPOINT_WIDE
    if width < medium:
        return 1
    if width < wide:
        return 2
    return 3


class ShowcaseWindow(QWidget):
    """One deterministic page rendering every Transfer Ledger primitive."""

    def __init__(
        self, motion: tokens.MotionPreference = tokens.MotionPreference.FULL
    ) -> None:
        """Build all fourteen primitive sections inside a scrolling grid."""
        super().__init__()
        self._motion: tokens.MotionPreference = motion
        self.setFont(fonts.ui_font(tokens.BODY_SIZE))
        self._columns: int = 3
        self._rails: list[TransferStageRail] = []
        self._loading: list[LoadingBlock] = []
        self._focus_targets: list[QWidget] = []
        self.setWindowTitle("HubFetch 组件展示")
        self._content: QWidget = QWidget()
        self._grid: QGridLayout = QGridLayout(self._content)
        self._grid.setContentsMargins(
            tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM
        )
        self._grid.setHorizontalSpacing(tokens.SPACE_SM)
        self._grid.setVerticalSpacing(tokens.SPACE_SM)
        self._grid.setAlignment(Qt.AlignmentFlag.AlignTop)
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setWidget(self._content)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(scroll)
        self._sections: list[tuple[str, QWidget]] = [
            (title, self._panel(title, section))
            for title, section in showcase_sections.build_all(
                motion, self._rails, self._loading, self._focus_targets
            )
        ]
        self._relayout()
        self.setAccessibleName("Transfer Ledger 基元展示")

    def content_widget(self) -> QWidget:
        """Return the offscreen render target covering all sections."""
        return self._content

    def section_titles(self) -> tuple[str, ...]:
        """Return every section title in display order."""
        return tuple(title for title, _ in self._sections)

    def column_count(self) -> int:
        """Return the responsive column count for the current width."""
        return self._columns

    def repo_fixture(self) -> str:
        """Return the long repository identifier stress fixture."""
        return fixtures.LONG_REPO_ID

    def set_motion(self, motion: tokens.MotionPreference) -> None:
        """Apply an animation policy to every animated primitive."""
        self._motion = motion
        for rail in self._rails:
            rail.set_motion_preference(motion)
        for block in self._loading:
            block.set_motion_preference(motion)

    def set_effective_width(self, width: int) -> None:
        """Resize to an effective-pixel width and reflow by breakpoint."""
        self._columns = _columns_for_width(width)
        self.resize(width, max(self.height(), _MIN_CAPTURE_HEIGHT))
        self._relayout()

    def stabilize_for_capture(self) -> None:
        """Freeze every animation at a deterministic frame before grabbing."""
        for rail in self._rails:
            rail.freeze_pulse()
        for block in self._loading:
            block.stop()

    def demo_keyboard_focus(self) -> None:
        """Give the focus-section demo widget keyboard focus.

        Deterministic captures cannot rely on interactive Tab navigation, so the
        showcase sets a keyboard-focus reason itself; the installed FocusRingStyle
        then renders the Action Blue ring inside the captured frame (DESIGN.md 3).
        """
        if self._focus_targets:
            self._focus_targets[0].setFocus(Qt.FocusReason.TabFocusReason)

    def _relayout(self) -> None:
        while self._grid.count():
            self._grid.takeAt(0)
        for index, (_, panel) in enumerate(self._sections):
            self._grid.addWidget(panel, index // self._columns, index % self._columns)

    def _panel(self, title: str, content: QWidget) -> QWidget:
        panel = QWidget()
        colors = semantic_colors(panel.palette())
        apply_panel(panel, colors.border, colors.surface)
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(
            tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM
        )
        layout.setSpacing(tokens.SPACE_XS)
        heading = QLabel(title)
        font = heading.font()
        font.setBold(True)
        heading.setFont(font)
        layout.addWidget(heading)
        layout.addWidget(content, stretch=1)
        return panel


def run_showcase() -> int:
    """Show the interactive showcase; the ``HubFetch.exe --showcase`` hook."""
    existing = QApplication.instance()
    if isinstance(existing, QApplication):
        app = existing
    else:
        app = QApplication([SHOWCASE_FLAG])
    fonts.register_bundled_fonts()
    app.setStyle(ui_style.SHOWCASE_STYLE)
    focus.install_focus_ring(app.style())
    app.setPalette(ui_style.build_light_palette())
    window = ShowcaseWindow()
    window.resize(tokens.BREAKPOINT_WIDE, 900)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(run_showcase())


__all__ = ["SHOWCASE_FLAG", "ShowcaseWindow", "is_showcase_request", "run_showcase"]
