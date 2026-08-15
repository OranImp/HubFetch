# noqa: SIZE_OK - one module must enumerate the whole shell contract: fixtures,
# the runtime harness, navigation exactness, routing, selection, back/focus,
# commands, Help gating, and geometry persistence.

"""Given/When/Then contracts for the composed responsive task shell.

Todo 24 composes the desktop shell: exact flat navigation, immutable task
snapshots rendered in a queue list, selection driving an immutable detail
view, narrow-mode back/focus behavior, native menu command routing, the
configured/unconfigured Help action, and safe window-geometry persistence.
The runtime is a real composed :class:`Runtime` over a temporary database;
tasks are inserted directly through the repository so no worker subprocess is
ever launched by these shell tests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import pytest
from PySide6.QtCore import QRect
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QAbstractButton, QLabel, QWidget

from hubfetch.application.runtime import Runtime, RuntimeConfig
from hubfetch.config.settings import Locale, Settings
from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.runtime_owner import FileLockRuntimeOwner
from hubfetch.ui import tokens
from hubfetch.ui.main_window import MainWindow, ShellMode, clamp_frame_to_available
from hubfetch.ui.navigation import Destination, ShellTexts
from tests.helpers.clock import ControllableClock

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Callable, Iterator
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.domain.ids import TaskId
    from hubfetch.domain.task_spec import TaskSpec


def _make_spec(repo: str, destination: Path) -> TaskSpec:
    """Build one complete Git clone specification for shell tests."""
    return GitCloneSpec(
        kind="git_clone",
        repository=RepositoryRef(
            repo_id=parse_repository_id(repo), kind=ModelRepository()
        ),
        destination=destination,
        auth_source=AuthSource.ANONYMOUS,
        proxy_mode=ProxyMode.SYSTEM,
    )


def build_runtime(
    tmp_path: Path,
) -> tuple[Runtime, TaskRepository, ControllableClock]:
    """Compose a started runtime over a fresh temporary database.

    The runtime is started before any task is inserted, and tasks are created
    through the repository directly, so the scheduler never dispatches a worker
    subprocess inside a shell test.
    """
    database = tmp_path / "hubfetch.db"
    connection: sqlite3.Connection = open_connection(database)
    migrate(connection)
    clock = ControllableClock()
    owner = FileLockRuntimeOwner(database.with_name(database.name + ".lock"))
    repository = TaskRepository(connection, clock=clock)
    runtime = Runtime(
        config=RuntimeConfig(
            repository=repository,
            owner=owner,
            connection=connection,
            settings=Settings(),
            parent_environment={},
            worker_command_prefix=("python", "-m", "hubfetch.scenarios.worker"),
        )
    )
    _ = runtime.start()
    return runtime, repository, clock


@dataclass
class ShellHarness:
    """One runtime plus a shell wired to it and the saved-settings sink."""

    runtime: Runtime
    repository: TaskRepository
    window: MainWindow
    saved: list[Settings]
    _counter: int = field(default=0)

    def add_task(self, repo: str, destination: Path) -> TaskId:
        """Insert one queued clone task through the repository only."""
        self._counter += 1
        task_id = parse_task_id(f"task-{self._counter}")
        attempt_id = parse_attempt_id(f"attempt-{self._counter}")
        _ = self.repository.create(task_id, _make_spec(repo, destination), attempt_id)
        return task_id


@pytest.fixture
def harness(qtbot: QtBot, tmp_path: Path) -> Iterator[ShellHarness]:
    """Yield a started shell over a real runtime with a settings sink."""
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


def _make_window(
    qtbot: QtBot,
    runtime: Runtime,
    *,
    settings: Settings | None = None,
    save_settings: Callable[[Settings], None] | None = None,
) -> MainWindow:
    """Build a shell over an existing runtime with optional overrides."""
    window = MainWindow(
        runtime=runtime,
        settings=settings if settings is not None else Settings(),
        texts=ShellTexts.for_locale(Locale.ZH_CN),
        save_settings=save_settings if save_settings is not None else lambda _s: None,
        degraded=(),
    )
    qtbot.addWidget(window)
    window.show()
    return window


def test_shell_opens_on_tasks_with_empty_state(harness: ShellHarness) -> None:
    """Given an empty runtime, When the shell starts, Then Tasks is current."""
    window = harness.window
    assert window.current_destination() is Destination.TASKS
    assert window.task_list_pane().is_empty_shown()
    assert window.task_list_pane().selected_task_id() is None


def test_navigation_is_exactly_three_primary_plus_settings_footer(
    harness: ShellHarness,
) -> None:
    """Given the shell, When inspecting navigation, Then only the locked set exists."""
    model = harness.window.navigation_model()
    assert model.primary_destinations() == (
        Destination.TASKS,
        Destination.CACHE,
        Destination.DIAGNOSTICS,
    )
    assert model.footer_destinations() == (Destination.SETTINGS,)
    pane = harness.window.navigation_pane()
    labels = {item.accessibleName() for item in pane.primary_items()}
    footer = {item.accessibleName() for item in pane.footer_items()}
    assert labels == {"任务", "缓存", "诊断"}
    assert footer == {"设置"}
    texts = {item.text() for item in (*pane.primary_items(), *pane.footer_items())}
    assert texts == {"任务", "缓存", "诊断", "设置"}
    all_widgets = harness.window.findChildren(QWidget)
    spoken = [
        widget.text()
        for widget in all_widgets
        if isinstance(widget, (QAbstractButton, QLabel))
    ]
    combined = " ".join(spoken)
    assert "上传" not in combined
    assert "Upload" not in combined


def test_cache_navigation_routes_destination(harness: ShellHarness) -> None:
    """Given the shell, When Cache activates, Then routing reports the destination."""
    received: list[str] = []
    harness.window.navigation_model().destination_changed.connect(received.append)
    harness.window.navigation_pane().primary_items()[1].click()
    assert harness.window.current_destination() is Destination.CACHE
    assert received == [Destination.CACHE.value]
    assert harness.window.detail_pane().is_showing_pending()


def test_settings_footer_item_routes_destination(harness: ShellHarness) -> None:
    """Given the shell, When footer Settings is activated, Then it routes too."""
    harness.window.navigation_pane().footer_items()[0].click()
    assert harness.window.current_destination() is Destination.SETTINGS
    assert harness.window.detail_pane().is_showing_pending()


def test_task_list_renders_fifo_snapshot_rows(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given three persisted tasks, When refreshing, Then rows follow FIFO order."""
    first = harness.add_task("org/alpha", tmp_path / "a")
    second = harness.add_task("org/beta", tmp_path / "b")
    third = harness.add_task("org/gamma", tmp_path / "c")
    harness.window.refresh()
    rows = harness.window.task_list_pane().task_rows()
    assert [row.repo_label().full_text() for row in rows] == [
        "org/alpha",
        "org/beta",
        "org/gamma",
    ]
    assert rows[0].accessibleName().startswith("克隆")
    assert harness.window.task_list_pane().task_ids() == (first, second, third)


def test_selecting_row_shows_immutable_detail(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a queued task, When selected, Then the detail shows its snapshot."""
    selected = harness.add_task("org/beta", tmp_path / "b")
    _ = harness.add_task("org/gamma", tmp_path / "c")
    harness.window.refresh()
    list_pane = harness.window.task_list_pane()
    list_pane.set_selected(selected)
    assert harness.window.task_selection().selected_task_id() == selected
    detail = harness.window.detail_pane()
    assert detail.is_showing_snapshot()
    assert detail.repository_label().full_text() == "org/beta"


def test_selection_survives_snapshot_rebuild(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a selection, When the queue snapshot is rebuilt, Then selection is kept."""
    _ = harness.add_task("org/alpha", tmp_path / "a")
    kept = harness.add_task("org/beta", tmp_path / "b")
    harness.window.refresh()
    harness.window.task_list_pane().set_selected(kept)
    harness.window.refresh()
    assert harness.window.task_selection().selected_task_id() == kept
    assert harness.window.task_list_pane().selected_task_id() == kept
    assert harness.window.detail_pane().is_showing_snapshot()


def test_narrow_mode_back_command_returns_to_list_and_focus(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given a narrow shell, When back fires, Then the list regains focus."""
    task = harness.add_task("org/alpha", tmp_path / "a")
    harness.window.refresh()
    harness.window.resize(700, 600)
    harness.window.task_list_pane().set_selected(task)
    assert harness.window.shell_mode() is ShellMode.NARROW
    assert harness.window.detail_pane().isVisible()
    assert not harness.window.task_list_pane().isVisible()
    detail = harness.window.detail_pane()
    assert detail.back_button().isVisible()
    detail.back_button().click()
    assert harness.window.task_list_pane().isVisible()
    assert not detail.isVisible()
    focused = harness.window.focusWidget()
    assert focused is not None
    assert focused.accessibleName() == "克隆 org/alpha"


def test_help_action_hidden_without_configured_url(harness: ShellHarness) -> None:
    """Given no help URL configured, When inspecting the shell, Then Help is absent."""
    assert harness.window.help_action() is None
    assert not harness.window.navigation_model().has_help()


def test_help_action_present_and_routing_when_configured(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a configured help URL, When inspecting, Then the Help action exists."""
    runtime, _repository, _clock = build_runtime(tmp_path)
    window = _make_window(
        qtbot,
        runtime,
        settings=Settings(help_url="https://example.com/releases"),
    )
    try:
        help_action = window.help_action()
        assert help_action is not None
        assert window.navigation_model().help_url() == "https://example.com/releases"
        fired: list[str] = []
        window.help_requested.connect(lambda: fired.append("help"))
        help_action.trigger()
        assert fired == ["help"]
    finally:
        window.close()
        _ = runtime.shutdown()
        runtime.close()


def test_menu_actions_route_typed_commands(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given the native menu, When commands fire, Then typed routing signals emit."""
    downloads: list[str] = []
    clones: list[str] = []
    refreshes: list[str] = []
    harness.window.create_download_requested.connect(lambda: downloads.append("d"))
    harness.window.create_clone_requested.connect(lambda: clones.append("c"))
    harness.window.refresh_requested.connect(lambda: refreshes.append("r"))
    harness.window.new_download_action().trigger()
    harness.window.new_clone_action().trigger()
    harness.window.refresh_action().trigger()
    assert downloads == ["d"]
    assert clones == ["c"]
    assert refreshes == ["r"]
    harness.add_task("org/alpha", tmp_path / "a")
    harness.window.refresh_action().trigger()
    assert len(harness.window.task_list_pane().task_rows()) == 1


def test_settings_menu_action_routes_to_footer_destination(
    harness: ShellHarness,
) -> None:
    """Given the Settings action, When triggered, Then Settings routes."""
    harness.window.settings_action().trigger()
    assert harness.window.current_destination() is Destination.SETTINGS


def test_close_persists_window_geometry(harness: ShellHarness) -> None:
    """Given an open shell, When closed, Then geometry persists to the settings sink."""
    harness.window.resize(1024, 768)
    harness.window.close()
    assert harness.saved
    assert harness.saved[-1].window_geometry is not None
    assert harness.saved[-1].window_state is not None


def test_clamp_frame_to_available_brings_offscreen_frame_inside() -> None:
    """Given an off-screen frame, When clamped, Then it fits a screen."""
    available = (QRect(0, 0, 1280, 800),)
    frame = QRect(4000, 4000, 900, 700)
    clamped = clamp_frame_to_available(frame, available)
    assert available[0].contains(clamped)
    assert clamped.width() <= 1280
    assert clamped.height() <= 800


def test_clamp_frame_larger_than_screen_caps_size() -> None:
    """Given a frame larger than the screen, When clamped, Then its size is capped."""
    available = (QRect(0, 0, 800, 600),)
    clamped = clamp_frame_to_available(QRect(10, 10, 1200, 900), available)
    assert clamped.width() <= 800
    assert clamped.height() <= 600


def test_offscreen_saved_geometry_clamps_on_restore(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given off-screen geometry, When restored, Then the shell lands on-screen."""
    runtime, _repository, _clock = build_runtime(tmp_path)
    dummy = QWidget()
    dummy.setGeometry(QRect(4000, 3000, 1000, 700))
    saved_geometry = bytes(dummy.saveGeometry().data())
    window = _make_window(
        qtbot, runtime, settings=Settings(window_geometry=saved_geometry)
    )
    try:
        frame = window.frameGeometry()
        assert any(
            screen.availableGeometry().intersects(frame)
            for screen in QGuiApplication.screens()
        )
    finally:
        window.close()
        _ = runtime.shutdown()
        runtime.close()


def test_window_default_width_meets_wide_breakpoint(harness: ShellHarness) -> None:
    """Given a fresh shell, When measuring its default width, Then it starts wide."""
    assert harness.window.width() >= tokens.BREAKPOINT_WIDE


def test_refresh_keeps_one_scroll_owner_per_region(
    harness: ShellHarness, tmp_path: Path
) -> None:
    """Given long content, When refreshing, Then each region has one scroll owner."""
    _ = harness.add_task("org/" + "x" * 300, tmp_path / "long")
    harness.window.refresh()
    list_scroll = harness.window.task_list_pane().scroll_area()
    detail_scroll = harness.window.detail_pane().scroll_area()
    assert list_scroll is not detail_scroll
    assert list_scroll.verticalScrollBar().maximum() >= 0
    assert detail_scroll.verticalScrollBar().maximum() >= 0
