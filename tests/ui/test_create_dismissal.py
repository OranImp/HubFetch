"""Dismissal contracts for the wired creation dialogs.

The New Download / New Clone dialogs must always be dismissible (Cancel, the
header X button, Escape) without creating a task, and a confirmed enqueue must
create the task and close the dialog. Fakes drive planning/preflight so no
network runs on the GUI thread.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

import pytest

from hubfetch.application.runtime import Runtime, RuntimeConfig
from hubfetch.config.settings import Locale, Settings
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.persistence.connection import open_connection
from hubfetch.persistence.migrations import migrate
from hubfetch.persistence.task_repository import TaskRepository
from hubfetch.runtime.runtime_owner import FileLockRuntimeOwner
from hubfetch.ui.create import CloneDialog, CreateTexts, DownloadDialog
from hubfetch.ui.main_window import MainWindow
from hubfetch.ui.navigation import ShellTexts
from hubfetch.ui.widgets.buttons import IconButton
from tests.helpers.clock import ControllableClock
from tests.ui.create.helpers import ControllableIdFactory, ManualDispatcher
from tests.ui.test_create_wiring import (
    ForwardingCloneService,
    ForwardingDownloadService,
)

if TYPE_CHECKING:
    import sqlite3
    from collections.abc import Iterator
    from pathlib import Path

    from pytestqt.qtbot import QtBot

TEXTS = CreateTexts.for_locale(Locale.ZH_CN)

DownloadDialogOrClone = DownloadDialog | CloneDialog
ForwardingService = ForwardingDownloadService | ForwardingCloneService


def build_runtime(tmp_path: Path) -> tuple[Runtime, TaskRepository]:
    """Compose a started runtime over a fresh temporary database."""
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


class TestDialogDismissal:
    """Given an open wired dialog, Cancel/X/Escape all close it without a task."""

    @pytest.mark.parametrize("kind", ["download", "clone"])
    def test_cancel_button_closes_without_creating(
        self,
        qtbot: QtBot,
        tmp_path: Path,
        window: tuple[MainWindow, Runtime, TaskRepository],
        kind: Literal["download", "clone"],
    ) -> None:
        _shell, runtime, _repository = window
        dialog, service = self._build_dialog(
            kind, runtime, tmp_path, ManualDispatcher()
        )
        qtbot.addWidget(dialog)
        dialog.show()
        assert dialog.cancel_button().isVisible()
        dialog.cancel_button().click()
        assert not dialog.isVisible()
        assert service.created == []

    @pytest.mark.parametrize("kind", ["download", "clone"])
    def test_header_close_button_dismisses(
        self,
        qtbot: QtBot,
        tmp_path: Path,
        window: tuple[MainWindow, Runtime, TaskRepository],
        kind: Literal["download", "clone"],
    ) -> None:
        _shell, runtime, _repository = window
        dialog, service = self._build_dialog(
            kind, runtime, tmp_path, ManualDispatcher()
        )
        title = TEXTS.download_title if kind == "download" else TEXTS.clone_title
        qtbot.addWidget(dialog)
        dialog.show()
        close_buttons = [
            button
            for button in dialog.findChildren(IconButton)
            if button.accessibleName() == title
        ]
        assert len(close_buttons) == 1
        close_buttons[0].click()
        assert not dialog.isVisible()
        assert service.created == []

    @pytest.mark.parametrize("kind", ["download", "clone"])
    def test_confirm_creates_and_closes(
        self,
        qtbot: QtBot,
        tmp_path: Path,
        window: tuple[MainWindow, Runtime, TaskRepository],
        kind: Literal["download", "clone"],
    ) -> None:
        _shell, runtime, repository = window
        dispatcher = ManualDispatcher()
        dialog, service = self._build_dialog(kind, runtime, tmp_path, dispatcher)
        qtbot.addWidget(dialog)
        dialog.show()
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.confirm()
        assert not dialog.isVisible()
        assert len(service.created) == 1
        record = repository.get(service.created[0][0])
        assert record is not None
        assert record.state is LifecycleState.QUEUED

    def _build_dialog(
        self,
        kind: Literal["download", "clone"],
        runtime: Runtime,
        tmp_path: Path,
        dispatcher: ManualDispatcher,
    ) -> tuple[DownloadDialogOrClone, ForwardingService]:
        """Construct one working dialog bound to its forwarding service."""
        match kind:
            case "download":
                service = ForwardingDownloadService(runtime, tmp_path / "cache")
                dialog = DownloadDialog(
                    service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
                )
                form = dialog.form()
                form.repo_id_field().set_text("org/repo")
                form.filename_field().set_text("model.safetensors")
                return dialog, service
            case "clone":
                service = ForwardingCloneService(runtime)
                dialog = CloneDialog(
                    service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
                )
                form = dialog.form()
                form.repo_id_field().set_text("org/repo")
                form.destination_field().set_text(str(tmp_path / "clone-target"))
                return dialog, service
