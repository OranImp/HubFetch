"""Shell-wiring contracts for the creation flows.

The New Download / New Clone commands open the working modal dialogs; their
confirmed enqueue reaches the runtime facade so the task appears in the Tasks
list. The placeholder copy is gone and the dialogs stay keyboard-operable;
fakes drive planning/preflight so no network runs on the GUI thread.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, assert_never, final

import pytest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QAbstractButton, QApplication, QLabel, QWidget

from hubfetch.application.runtime import Runtime, RuntimeConfig
from hubfetch.config.settings import Locale, Settings
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.runtime_owner import FileLockRuntimeOwner
from hubfetch.ui.create import CloneDialog, ClonePreflight, CreateTexts, DownloadDialog
from hubfetch.ui.create.services import RuntimeCloneService, RuntimeDownloadService
from hubfetch.ui.main_window import MainWindow
from hubfetch.ui.navigation import ShellTexts
from tests.helpers.clock import ControllableClock
from tests.ui.create.helpers import (
    ControllableIdFactory,
    ManualDispatcher,
    make_plan,
    make_preflight,
)

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import (
        SingleFileDownloadSpec,
        SnapshotDownloadSpec,
        TaskSpec,
    )
    from hubfetch.hub.planner import DownloadPlan
    from hubfetch.persistence.records import TaskRecord

TEXTS = CreateTexts.for_locale(Locale.ZH_CN)


def build_runtime(tmp_path: Path) -> tuple[Runtime, TaskRepository]:
    database = tmp_path / "hubfetch.db"
    connection: sqlite3.Connection = open_connection(database)
    migrate(connection)
    repository = TaskRepository(connection, clock=ControllableClock())
    runtime = Runtime(
        config=RuntimeConfig(
            repository=repository,
            owner=FileLockRuntimeOwner(database.with_name(database.name + ".lock")),
            connection=connection,
            settings=Settings(),
            parent_environment={},
            worker_command_prefix=("python", "-m", "hubfetch.scenarios.worker"),
        )
    )
    _ = runtime.start()
    return runtime, repository


@pytest.fixture
def window(
    qtbot: QtBot, tmp_path: Path
) -> Iterator[tuple[MainWindow, Runtime, TaskRepository]]:
    """Yield a shown shell over a real runtime with a settings sink."""
    runtime, repository = build_runtime(tmp_path)
    window = MainWindow(
        runtime=runtime,
        settings=Settings(),
        texts=ShellTexts.for_locale(Locale.ZH_CN),
        save_settings=lambda _settings: None,
        degraded=(),
    )
    qtbot.addWidget(window)
    window.show()
    yield window, runtime, repository
    window.close()
    _ = runtime.shutdown()
    runtime.close()


@final
class ForwardingDownloadService:
    """DownloadCreateService whose enqueue forwards to the runtime facade."""

    _runtime: Runtime
    _destination: Path

    def __init__(self, runtime: Runtime, destination: Path) -> None:
        """Bind the runtime and the canned plan destination."""
        self._runtime = runtime
        self._destination = destination
        self.created: list[tuple[TaskId, TaskSpec, AttemptId]] = []

    def plan(self, spec: SingleFileDownloadSpec | SnapshotDownloadSpec) -> DownloadPlan:
        """Return a canned sufficient plan for the given destination."""
        del spec
        return make_plan(destination=self._destination)

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Record the payload and persist it through the runtime facade."""
        self.created.append((task_id, spec, attempt_id))
        return self._runtime.create_task(task_id, spec, attempt_id)


@final
class ForwardingCloneService:
    """CloneCreateService whose enqueue forwards to the runtime facade."""

    _runtime: Runtime

    def __init__(self, runtime: Runtime) -> None:
        """Bind the runtime facade."""
        self._runtime = runtime
        self.created: list[tuple[TaskId, TaskSpec, AttemptId]] = []

    def preflight(self, destination: Path) -> ClonePreflight:
        """Return a canned ready preflight report."""
        del destination
        return make_preflight()

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Record the payload and persist it through the runtime facade."""
        self.created.append((task_id, spec, attempt_id))
        return self._runtime.create_task(task_id, spec, attempt_id)


class TestCreateDialogWiring:
    """Given the native commands, the working dialogs open as modal sheets."""

    def test_new_download_action_opens_download_dialog(
        self, window: tuple[MainWindow, Runtime, TaskRepository]
    ) -> None:
        shell, _runtime, _repository = window
        shell.new_download_action().trigger()
        dialog = shell.findChild(DownloadDialog)
        assert dialog is not None
        assert dialog.isVisible()
        assert dialog.isModal()
        assert dialog.windowTitle() == TEXTS.download_title
        assert isinstance(shell.download_create_service(), RuntimeDownloadService)
        assert dialog.service() is shell.download_create_service()

    def test_new_clone_action_opens_clone_dialog(
        self, window: tuple[MainWindow, Runtime, TaskRepository]
    ) -> None:
        shell, _runtime, _repository = window
        shell.new_clone_action().trigger()
        dialog = shell.findChild(CloneDialog)
        assert dialog is not None
        assert dialog.isVisible()
        assert dialog.isModal()
        assert dialog.windowTitle() == TEXTS.clone_title
        assert isinstance(shell.clone_create_service(), RuntimeCloneService)
        assert dialog.service() is shell.clone_create_service()


class TestCreateEnqueueThroughRuntime:
    """Given a confirmed dialog, the task reaches the runtime and the list."""

    @pytest.mark.parametrize("kind", ["download", "clone"])
    def test_confirmed_task_appears_in_list(
        self,
        qtbot: QtBot,
        tmp_path: Path,
        window: tuple[MainWindow, Runtime, TaskRepository],
        kind: Literal["download", "clone"],
    ) -> None:
        shell, runtime, repository = window
        dispatcher = ManualDispatcher()
        match kind:
            case "download":
                service = ForwardingDownloadService(runtime, tmp_path / "cache")
                dialog = DownloadDialog(
                    service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
                )
                form = dialog.form()
                form.repo_id_field().set_text("org/repo")
                form.filename_field().set_text("model.safetensors")
            case "clone":
                service = ForwardingCloneService(runtime)
                dialog = CloneDialog(
                    service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
                )
                form = dialog.form()
                form.repo_id_field().set_text("org/repo")
                form.destination_field().set_text(str(tmp_path / "clone-target"))
            case _:
                assert_never(kind)
        qtbot.addWidget(dialog)
        dialog.show()
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.confirm()
        self._assert_enqueued(shell, repository, service, service.created[0][0])

    @staticmethod
    def _assert_enqueued(
        shell: MainWindow,
        repository: TaskRepository,
        service: ForwardingDownloadService | ForwardingCloneService,
        task_id: TaskId,
    ) -> None:
        assert len(service.created) == 1
        record = repository.get(task_id)
        assert record is not None
        assert record.state is LifecycleState.QUEUED
        shell.refresh()
        assert shell.task_list_pane().task_ids() == (task_id,)


class TestPlaceholderRemoved:
    """Given the wired create flows, no placeholder copy remains."""

    def test_create_flows_never_show_pending_placeholder(
        self, window: tuple[MainWindow, Runtime, TaskRepository]
    ) -> None:
        shell, _runtime, _repository = window
        shell.new_download_action().trigger()
        download = shell.findChild(DownloadDialog)
        assert download is not None
        assert not shell.detail_pane().is_showing_pending()
        QTest.keyClick(download, Qt.Key.Key_Escape)
        shell.new_clone_action().trigger()
        assert shell.findChild(CloneDialog) is not None
        assert not shell.detail_pane().is_showing_pending()

    def test_placeholder_copy_gone(
        self, window: tuple[MainWindow, Runtime, TaskRepository]
    ) -> None:
        shell, _runtime, _repository = window
        all_widgets = shell.findChildren(QWidget)
        spoken = " ".join(
            widget.text()
            for widget in all_widgets
            if isinstance(widget, (QAbstractButton, QLabel))
        )
        assert "ships in a later release" not in spoken
        assert "将在后续版本提供" not in spoken
        assert "该工作区尚未提供" not in spoken
        assert "This workspace is not available yet" not in spoken


class TestDialogKeyboardOperable:
    """Given an open wired dialog, Tab and Escape work as documented."""

    def test_wired_download_dialog_tab_order(
        self, window: tuple[MainWindow, Runtime, TaskRepository]
    ) -> None:
        shell, _runtime, _repository = window
        shell.new_download_action().trigger()
        dialog = shell.findChild(DownloadDialog)
        assert dialog is not None
        form = dialog.form()
        form.repo_id_field().editor().setFocus()
        QTest.keyClick(dialog, Qt.Key.Key_Tab)
        assert QApplication.focusWidget() is form.revision_field().editor()
        QTest.keyClick(dialog, Qt.Key.Key_Tab)
        assert QApplication.focusWidget() is form.filename_field().editor()

    def test_wired_download_dialog_escape_closes(
        self, qtbot: QtBot, window: tuple[MainWindow, Runtime, TaskRepository]
    ) -> None:
        shell, _runtime, _repository = window
        shell.new_download_action().trigger()
        dialog = shell.findChild(DownloadDialog)
        assert dialog is not None
        QTest.keyClick(dialog, Qt.Key.Key_Escape)
        qtbot.waitUntil(lambda: shell.findChild(DownloadDialog) is None, timeout=5000)
