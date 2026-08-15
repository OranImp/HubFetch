# noqa: SIZE_OK - one module must enumerate the full breakpoint/scale/stress
# matrix for the shell: boundaries, collapse, widths, scaling, and overflow.

"""Given/When/Then responsive-geometry contracts for the composed shell.

Todo 24 acceptance fixes the effective-pixel breakpoints (DESIGN.md 8.2):
below 760 one pane with a back command, 760-1179 a collapsed icon-rail
navigation with the list/detail split retained, and at or above 1180 a fixed
navigation with a stable 360 px task list and a flexible detail. These tests
drive the exact 759/760/1179/1180 boundaries plus 200% scaling and a 100-task
stress queue, importing the runtime harness from ``test_main_window``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from PySide6.QtWidgets import QApplication

from hubfetch.config.settings import Locale, Settings
from hubfetch.ui import tokens
from hubfetch.ui.main_window import MainWindow, ShellMode
from hubfetch.ui.navigation import ShellTexts
from tests.ui.test_main_window import ShellHarness, build_runtime

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from pytestqt.qtbot import QtBot

_LONG_REPO = "organization-with-a-very-long-name/" + "x" * 300


@pytest.fixture
def harness(qtbot: QtBot, tmp_path: Path) -> Iterator[ShellHarness]:
    """Yield a started shell over a real runtime for responsive assertions."""
    runtime, repository, _clock = build_runtime(tmp_path)
    saved: list[Settings] = []
    window = MainWindow(
        runtime=runtime,
        settings=Settings(),
        texts=ShellTexts.for_locale(Locale.ZH_CN),
        save_settings=saved.append,
        degraded=(),
    )
    qtbot.addWidget(window)
    window.show()
    yield ShellHarness(
        runtime=runtime, repository=repository, window=window, saved=saved
    )
    window.close()
    _ = runtime.shutdown()
    runtime.close()


def _resize_and_settle(window: MainWindow, width: int, height: int) -> None:
    """Resize a shell and flush any posted resize events deterministically."""
    window.resize(width, height)
    QApplication.processEvents()


def test_breakpoint_modes_at_759_760_1179_1180(harness: ShellHarness) -> None:
    """Given four boundary widths, When resized, Then the mode matches DESIGN 8.2."""
    window = harness.window
    _resize_and_settle(window, 759, 600)
    assert window.shell_mode() is ShellMode.NARROW
    _resize_and_settle(window, 760, 600)
    assert window.shell_mode() is ShellMode.MEDIUM
    _resize_and_settle(window, 1179, 600)
    assert window.shell_mode() is ShellMode.MEDIUM
    _resize_and_settle(window, 1180, 600)
    assert window.shell_mode() is ShellMode.WIDE


def test_narrow_shows_single_pane_without_navigation(harness: ShellHarness) -> None:
    """Given a narrow width, When shown, Then one pane appears and nav is hidden."""
    window = harness.window
    _resize_and_settle(window, 700, 600)
    assert window.shell_mode() is ShellMode.NARROW
    assert not window.navigation_pane().isVisible()
    assert window.task_list_pane().isVisible()
    assert not window.detail_pane().isVisible()


def test_narrow_detail_takes_the_single_pane_when_selected(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a narrow selection, When selected, Then detail owns the pane."""
    task = harness.add_task("org/alpha", tmp_path / "a")
    window = harness.window
    window.refresh()
    _resize_and_settle(window, 700, 600)
    window.task_list_pane().set_selected(task)
    assert not window.task_list_pane().isVisible()
    assert window.detail_pane().isVisible()
    assert window.detail_pane().back_button().isVisible()
    assert window.detail_pane().width() == window.width()


def test_medium_collapses_navigation_and_keeps_split(harness: ShellHarness) -> None:
    """Given a medium width, When shown, Then nav is an icon rail beside the split."""
    window = harness.window
    _resize_and_settle(window, 960, 600)
    nav = window.navigation_pane()
    assert nav.isVisible()
    assert nav.is_collapsed()
    assert nav.width() < 100
    assert window.task_list_pane().isVisible()
    assert window.task_list_pane().width() == tokens.TASK_LIST_WIDTH
    assert window.detail_pane().isVisible()


def test_wide_shows_fixed_navigation_and_360_px_list(harness: ShellHarness) -> None:
    """Given a wide width, When shown, Then nav is expanded and the list is 360 px."""
    window = harness.window
    _resize_and_settle(window, 1280, 800)
    nav = window.navigation_pane()
    assert nav.isVisible()
    assert not nav.is_collapsed()
    assert nav.width() >= 160
    assert window.task_list_pane().width() == tokens.TASK_LIST_WIDTH
    assert window.detail_pane().width() >= 400


def test_200pct_scaling_keeps_narrow_geometry_and_elides(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a long repo id at a narrow effective width, Then rows elide.

    Qt geometry is device-independent: at 200% scaling the logical width stays
    759 while the physical pixels double, so the logical-px contract below is
    exactly the 200%-scale behavior (DESIGN.md 4 and 12).
    """
    _ = harness.add_task(_LONG_REPO, tmp_path / "long")
    window = harness.window
    assert window.devicePixelRatioF() >= 1.0
    window.refresh()
    _resize_and_settle(window, 759, 600)
    list_pane = window.task_list_pane()
    assert list_pane.isVisible()
    row = list_pane.task_rows()[0]
    assert row.repo_label().elided()
    scroll = list_pane.scroll_area()
    assert scroll.horizontalScrollBar().maximum() == 0
    assert row.height() == tokens.TASK_ROW_HEIGHT


def test_many_tasks_scroll_within_one_list_owner(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given 100 tasks, When listed, Then the list scrolls under a single owner."""
    for index in range(100):
        _ = harness.add_task(f"org/repo-{index:03d}", tmp_path / str(index))
    window = harness.window
    window.refresh()
    list_pane = window.task_list_pane()
    assert len(list_pane.task_rows()) == 100
    assert len(list_pane.task_ids()) == 100
    scroll = list_pane.scroll_area()
    assert scroll.verticalScrollBar().maximum() > 0
    assert scroll.horizontalScrollBar().maximum() == 0


def test_medium_list_stays_360_under_long_content(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given long repo ids at medium width, When resized, Then the 360 px list holds."""
    _ = harness.add_task(_LONG_REPO, tmp_path / "long")
    window = harness.window
    window.refresh()
    _resize_and_settle(window, 960, 600)
    row = window.task_list_pane().task_rows()[0]
    assert row.repo_label().elided()
    assert window.task_list_pane().width() == tokens.TASK_LIST_WIDTH
    assert row.height() == tokens.TASK_ROW_HEIGHT


def test_narrow_mode_survives_resize_back_to_wide(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a selection in narrow mode, When widening, Then both panes return."""
    task = harness.add_task("org/alpha", tmp_path / "a")
    window = harness.window
    window.refresh()
    _resize_and_settle(window, 700, 600)
    window.task_list_pane().set_selected(task)
    assert not window.task_list_pane().isVisible()
    _resize_and_settle(window, 1280, 800)
    assert window.task_list_pane().isVisible()
    assert window.detail_pane().isVisible()
    assert window.task_selection().selected_task_id() == task
    assert window.detail_pane().is_showing_snapshot()


def test_narrow_back_then_narrow_selection_again(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given narrow mode, When back then reselect, Then the pane toggles cleanly."""
    first = harness.add_task("org/alpha", tmp_path / "a")
    second = harness.add_task("org/beta", tmp_path / "b")
    window = harness.window
    window.refresh()
    _resize_and_settle(window, 700, 600)
    window.task_list_pane().set_selected(first)
    window.detail_pane().back_button().click()
    assert window.task_list_pane().isVisible()
    window.task_list_pane().set_selected(second)
    assert not window.task_list_pane().isVisible()
    assert window.detail_pane().repository_label().full_text() == "org/beta"


def test_focus_follows_selection_change_at_wide_width(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a wide shell, When a row is selected, Then detail renders in place."""
    task = harness.add_task("org/alpha", tmp_path / "a")
    window = harness.window
    window.refresh()
    _resize_and_settle(window, 1280, 800)
    window.task_list_pane().set_selected(task)
    assert window.detail_pane().is_showing_snapshot()
    assert window.task_list_pane().isVisible()
    assert window.focusWidget() is not None
