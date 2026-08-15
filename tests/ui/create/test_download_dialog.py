# noqa: SIZE_OK - one module must enumerate the whole download-dialog contract:
# field dependencies, keyboard order, validation, async planning state, plan
# invalidation, estimates, confirmation payloads, and secret absence.

"""Given/When/Then contracts for the transient Download creation dialog.

The dialog is composed over a typed fake download service and a manual
dispatcher so the async planning state machine can be driven one step at a
time: validation blocks planning, planning suspends Confirm, a ready plan
renders estimates and enables Confirm, and only a confirmed enqueue reaches the
service. No network call ever runs on the GUI thread in these tests.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QLabel

from hubfetch.config.settings import Locale
from hubfetch.domain.errors import ErrorCategory, error_for
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    LocalDirectoryDestination,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.ui.create.contracts import CreateFlowState
from hubfetch.ui.create.download_dialog import DownloadDialog
from hubfetch.ui.create.texts import CreateTexts

from .helpers import (
    SENTINEL,
    ControllableIdFactory,
    FakeDownloadService,
    ManualDispatcher,
    make_plan,
)

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.ui.create.download_form import DownloadForm

TEXTS = CreateTexts.for_locale(Locale.ZH_CN)


def _fill_file_form(form: DownloadForm, *, repo_id: str = "org/repo") -> None:
    """Fill the minimal file-mode fields required for a valid plan."""
    form.repo_id_field().set_text(repo_id)
    form.filename_field().set_text("model.safetensors")


@pytest.fixture
def dialog(
    qtbot: QtBot, tmp_path: Path
) -> tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]:
    """Yield a shown download dialog over a fake service and manual dispatcher."""
    service = FakeDownloadService(plan=make_plan(destination=tmp_path / "cache"))
    dispatcher = ManualDispatcher()
    dialog = DownloadDialog(
        service,
        TEXTS,
        ids=ControllableIdFactory(),
        dispatcher=dispatcher,
    )
    qtbot.addWidget(dialog)
    dialog.show()
    return dialog, service, dispatcher


class TestFieldDependencies:
    """Given mode/destination/proxy switches, the dependent fields appear."""

    def test_file_mode_shows_filename_hides_patterns(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        form = dialog[0].form()
        assert form.mode_segments().current_key() == "file"
        assert form.filename_field().isVisibleTo(form)
        assert not form.include_field().isVisibleTo(form)

    def test_snapshot_mode_shows_patterns_hides_filename(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        form = dialog[0].form()
        form.mode_segments().set_current("snapshot")
        assert not form.filename_field().isVisibleTo(form)
        assert form.include_field().isVisibleTo(form)
        assert form.exclude_field().isVisibleTo(form)

    def test_local_destination_shows_path_and_browse(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        form = dialog[0].form()
        assert form.destination_segments().current_key() == "cache"
        assert not form.local_path_field().isVisibleTo(form)
        form.destination_segments().set_current("local_directory")
        assert form.local_path_field().isVisibleTo(form)
        assert form.browse_button().isVisibleTo(form)

    def test_manual_proxy_shows_url_field(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        form = dialog[0].form()
        assert not form.proxy_url_field().isVisibleTo(form)
        form.proxy_combo().set_current_key(ProxyMode.MANUAL.value)
        assert form.proxy_url_field().isVisibleTo(form)


class TestValidation:
    """Given invalid inputs, planning is blocked with inline field errors."""

    def test_invalid_repo_id_blocks_plan(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        dialog_widget.form().repo_id_field().set_text("no-slash")
        dialog_widget.form().filename_field().set_text("x.bin")
        dialog_widget.request_plan()
        assert dispatcher.pending == []
        assert service.planned_specs == []
        assert dialog_widget.form().repo_id_field().error_message() is not None
        assert dialog_widget.status() is CreateFlowState.EDITING
        assert not dialog_widget.confirm_button().isEnabled()

    def test_non_hex_commit_revision_rejected(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        dialog_widget.form().revision_field().set_text("z" * 40)
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        assert service.planned_specs == []
        assert dispatcher.pending == []
        assert dialog_widget.form().revision_field().error_message() is not None

    def test_empty_pattern_line_rejected_in_snapshot_mode(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        form = dialog_widget.form()
        form.mode_segments().set_current("snapshot")
        form.repo_id_field().set_text("org/repo")
        form.include_field().set_text("*.json\n\n*.md")
        dialog_widget.request_plan()
        assert service.planned_specs == []
        assert dispatcher.pending == []
        assert form.include_field().error_text() is not None

    def test_invalid_manual_proxy_rejected(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        form = dialog_widget.form()
        form.proxy_combo().set_current_key(ProxyMode.MANUAL.value)
        form.proxy_url_field().set_text("socks5://localhost:1080")
        _fill_file_form(form)
        dialog_widget.request_plan()
        assert service.planned_specs == []
        assert dispatcher.pending == []
        assert form.proxy_url_field().error_message() is not None


class TestPlanningState:
    """Given a valid form, planning suspends Confirm until the outcome lands."""

    def test_planning_state_suspends_confirm(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, _service, dispatcher = dialog
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        assert dialog_widget.status() is CreateFlowState.PLANNING
        assert len(dispatcher.pending) == 1
        assert not dialog_widget.confirm_button().isEnabled()
        assert dialog_widget.confirm_reason() == TEXTS.confirm_reason_planning

    def test_ready_plan_enables_confirm_and_renders_estimates(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        dispatcher.run_one()
        assert dialog_widget.status() is CreateFlowState.PLANNED
        assert dialog_widget.confirm_button().isEnabled()
        assert dialog_widget.confirm_reason() is None
        assert len(service.planned_specs) == 1
        summary = dialog_widget.plan_summary()
        assert summary["files"] == "2"
        assert summary["resolved_commit"]
        assert summary["disk"] == TEXTS.disk_sufficient

    def test_changed_input_invalidates_a_stale_plan(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, _service, dispatcher = dialog
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        dispatcher.run_one()
        assert dialog_widget.status() is CreateFlowState.PLANNED
        dialog_widget.form().repo_id_field().set_text("other/name")
        assert dialog_widget.status() is CreateFlowState.EDITING
        assert not dialog_widget.confirm_button().isEnabled()
        assert dialog_widget.confirm_reason() == TEXTS.confirm_reason_changed

    def test_planning_ignores_reentrant_requests(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, _service, dispatcher = dialog
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        dialog_widget.request_plan()
        assert len(dispatcher.pending) == 1


class TestPlanFailures:
    """Given a typed planning failure, no task is created and recovery is shown."""

    def test_gated_repository_blocks_confirm(self, qtbot: QtBot) -> None:
        service = FakeDownloadService(
            plan_error=error_for(
                ErrorCategory.GATED_ACCESS, detail="access not granted"
            )
        )
        dispatcher = ManualDispatcher()
        dialog = DownloadDialog(
            service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
        )
        qtbot.addWidget(dialog)
        dialog.show()
        _fill_file_form(dialog.form())
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.status() is CreateFlowState.FAILED
        assert not dialog.confirm_button().isEnabled()
        assert service.created == []
        assert dialog.confirm_reason() == TEXTS.confirm_reason_failed
        spoken = " ".join(widget.text() for widget in dialog.findChildren(QLabel))
        assert TEXTS.error_titles[ErrorCategory.GATED_ACCESS.value] in spoken

    def test_insufficient_disk_blocks_confirm(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        service = FakeDownloadService(
            plan=make_plan(destination=tmp_path / "cache", sufficient=False)
        )
        dispatcher = ManualDispatcher()
        dialog = DownloadDialog(
            service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
        )
        qtbot.addWidget(dialog)
        dialog.show()
        _fill_file_form(dialog.form())
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.status() is CreateFlowState.FAILED
        assert service.created == []
        assert not dialog.confirm_button().isEnabled()

    def test_cancelled_planning_never_creates(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        dialog_widget.close()
        dispatcher.run_one()
        assert service.created == []


class TestConfirmation:
    """Given a confirmed plan, the exact typed payload reaches the service."""

    def test_single_file_enqueue_payload(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        dispatcher.run_one()
        assert dialog_widget.confirm()
        assert len(service.created) == 1
        _task_id, spec, _attempt_id = service.created[0]
        assert isinstance(spec, SingleFileDownloadSpec)
        assert spec.repository.repo_id == "org/repo"
        assert spec.filename == "model.safetensors"
        assert isinstance(spec.destination, CacheDestination)
        assert spec.auth_source is AuthSource.ANONYMOUS
        assert spec.proxy_mode is ProxyMode.SYSTEM
        assert dialog_widget.created_spec() is spec

    def test_snapshot_enqueue_payload_with_patterns_and_local_destination(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        form = dialog_widget.form()
        form.mode_segments().set_current("snapshot")
        form.repo_id_field().set_text("org/repo")
        form.include_field().set_text("*.json\n*.md")
        form.exclude_field().set_text("*.bin")
        form.destination_segments().set_current("local_directory")
        form.local_path_field().set_text(str(dialog[0].parent() or "C:\\tmp\\out"))
        dialog_widget.request_plan()
        dispatcher.run_one()
        assert dialog_widget.confirm()
        spec = service.created[0][1]
        assert isinstance(spec, SnapshotDownloadSpec)
        assert spec.include_patterns == ("*.json", "*.md")
        assert spec.exclude_patterns == ("*.bin",)
        assert isinstance(spec.destination, LocalDirectoryDestination)
        assert spec.conflict_policy.kind == "overwrite_existing"

    def test_confirm_before_plan_does_nothing(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, _dispatcher = dialog
        assert not dialog_widget.confirm()
        assert service.created == []

    def test_task_created_signal_carries_spec(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, _service, dispatcher = dialog
        received: list[TaskSpec] = []
        dialog_widget.task_created.connect(received.append)
        _fill_file_form(dialog_widget.form())
        dialog_widget.request_plan()
        dispatcher.run_one()
        dialog_widget.confirm()
        assert len(received) == 1
        assert isinstance(received[0], SingleFileDownloadSpec)


class TestSecretsAndBrowse:
    """Given a manual-token selection, no secret value ever appears."""

    def test_manual_token_source_leaves_no_secret_bytes(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, service, dispatcher = dialog
        form = dialog_widget.form()
        form.auth_combo().set_current_key(AuthSource.MANUAL_TOKEN.value)
        _fill_file_form(form)
        dialog_widget.request_plan()
        dispatcher.run_one()
        assert dialog_widget.confirm()
        spec = service.created[0][1]
        assert spec.auth_source is AuthSource.MANUAL_TOKEN
        assert SENTINEL not in json.dumps(spec.model_dump())
        spoken = " ".join(
            widget.text() for widget in dialog_widget.findChildren(QLabel)
        )
        assert SENTINEL not in spoken

    def test_cancelled_browse_keeps_local_path(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        service = FakeDownloadService(plan=make_plan(destination=tmp_path / "cache"))
        dialog = DownloadDialog(
            service,
            TEXTS,
            ids=ControllableIdFactory(),
            dispatcher=ManualDispatcher(),
            directory_picker=lambda _title: "",
        )
        qtbot.addWidget(dialog)
        dialog.show()
        form = dialog.form()
        form.destination_segments().set_current("local_directory")
        form.browse_button().click()
        assert form.local_path_field().editor().text() == ""


class TestKeyboardOrder:
    """Given a shown dialog, Tab walks the fields in creation order."""

    def test_file_mode_tab_sequence(
        self, dialog: tuple[DownloadDialog, FakeDownloadService, ManualDispatcher]
    ) -> None:
        dialog_widget, _service, _dispatcher = dialog
        form = dialog_widget.form()
        form.repo_id_field().editor().setFocus()
        QTest.keyClick(dialog_widget, Qt.Key.Key_Tab)
        assert QApplication.focusWidget() is form.revision_field().editor()
        QTest.keyClick(dialog_widget, Qt.Key.Key_Tab)
        assert QApplication.focusWidget() is form.filename_field().editor()


class TestOffThreadDispatch:
    """Given the real thread-pool dispatcher, planning completes asynchronously."""

    def test_real_thread_pool_reaches_planned(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        service = FakeDownloadService(plan=make_plan(destination=tmp_path / "cache"))
        dialog = DownloadDialog(service, TEXTS, ids=ControllableIdFactory())
        qtbot.addWidget(dialog)
        dialog.show()
        _fill_file_form(dialog.form())
        dialog.request_plan()
        assert dialog.status() is CreateFlowState.PLANNING
        qtbot.waitUntil(
            lambda: dialog.status() is CreateFlowState.PLANNED, timeout=5000
        )
        assert dialog.confirm_button().isEnabled()
        assert service.created == []
