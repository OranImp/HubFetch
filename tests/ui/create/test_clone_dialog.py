# noqa: SIZE_OK - one module must enumerate the whole clone-dialog contract:
# transport dependencies, destination empty-directory rule, preflight state,
# dependency blockers, recheck recovery, confirmation payloads, and secrets.

"""Given/When/Then contracts for the transient Clone creation dialog.

The dialog is composed over a typed fake clone service and a manual dispatcher
so the preflight state machine can be driven one step at a time: the Todo 19
empty-destination rule blocks preflight inline, a ready report renders the
Git/Git-Xet and destination verdict before Confirm is enabled, and missing
dependencies or non-empty destinations show one recovery action that re-runs
preflight. No subprocess or network call ever runs on the GUI thread.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QLabel

from hubfetch.config.settings import Locale
from hubfetch.diagnostics.git import DependencyState, XetState
from hubfetch.domain.errors import ErrorCategory
from hubfetch.domain.task_spec import AuthSource, GitCloneSpec, ProxyMode
from hubfetch.ui.create.clone_dialog import CloneDialog
from hubfetch.ui.create.contracts import CreateFlowState, TransportChoice
from hubfetch.ui.create.texts import CreateTexts

from .helpers import (
    SENTINEL,
    ControllableIdFactory,
    FakeCloneService,
    ManualDispatcher,
    make_preflight,
)

if TYPE_CHECKING:
    from pathlib import Path

    from pytestqt.qtbot import QtBot

    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.ui.create.clone_form import CloneForm

TEXTS = CreateTexts.for_locale(Locale.ZH_CN)


def _fill_https_form(form: CloneForm, *, destination: str) -> None:
    """Fill the minimal HTTPS-mode fields required for a valid preflight."""
    form.repo_id_field().set_text("org/repo")
    form.destination_field().set_text(destination)


@pytest.fixture
def clone_dialog(
    qtbot: QtBot,
) -> tuple[CloneDialog, FakeCloneService, ManualDispatcher]:
    """Yield a shown clone dialog over a fake service and manual dispatcher."""
    service = FakeCloneService(preflight=make_preflight())
    dispatcher = ManualDispatcher()
    dialog = CloneDialog(
        service,
        TEXTS,
        ids=ControllableIdFactory(),
        dispatcher=dispatcher,
    )
    qtbot.addWidget(dialog)
    dialog.show()
    return dialog, service, dispatcher


class TestTransportDependencies:
    """Given HTTPS/SSH transport, the matching inputs appear and validate."""

    def test_https_shows_repo_id_hides_ssh(
        self, clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher]
    ) -> None:
        form = clone_dialog[0].form()
        assert form.transport_segments().current_key() == "https"
        assert form.repo_id_field().isVisibleTo(form)
        assert not form.ssh_url_field().isVisibleTo(form)

    def test_ssh_shows_url_hides_repo_id(
        self, clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher]
    ) -> None:
        form = clone_dialog[0].form()
        form.transport_segments().set_current(TransportChoice.SSH.value)
        assert not form.repo_id_field().isVisibleTo(form)
        assert form.ssh_url_field().isVisibleTo(form)

    def test_ssh_url_embedding_password_rejected(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        form = dialog.form()
        form.transport_segments().set_current(TransportChoice.SSH.value)
        form.ssh_url_field().set_text("git@hf.co:org/repo")
        form.destination_field().set_text(str(tmp_path / "c"))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.status() is CreateFlowState.PLANNED
        assert service.created == []
        form.ssh_url_field().set_text("user:secret@host:org/repo")
        dialog.request_plan()
        assert len(service.preflighted_destinations) == 1
        assert form.ssh_url_field().error_message() is not None


class TestEmptyDestinationRule:
    """Given a non-empty or non-directory destination, preflight is blocked."""

    def test_empty_destination_blocks_inline(
        self, clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher]
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        dialog.form().destination_field().set_text("")
        _fill_https_form(dialog.form(), destination="")
        dialog.request_plan()
        assert dispatcher.pending == []
        assert service.preflighted_destinations == []
        assert dialog.form().destination_field().error_message() is not None
        assert dialog.status() is CreateFlowState.EDITING

    def test_non_empty_directory_blocks_inline(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        occupied = tmp_path / "occupied"
        occupied.mkdir()
        (occupied / "file.txt").write_text("x", encoding="utf-8")
        _fill_https_form(dialog.form(), destination=str(occupied))
        dialog.request_plan()
        assert service.preflighted_destinations == []
        assert dispatcher.pending == []
        assert dialog.form().destination_field().error_message() is not None
        assert dialog.status() is CreateFlowState.EDITING

    def test_absent_destination_passes_inline_rule(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, _service, dispatcher = clone_dialog
        target = tmp_path / "new-clone"
        _fill_https_form(dialog.form(), destination=str(target))
        dialog.request_plan()
        assert len(dispatcher.pending) == 1

    def test_preflight_non_empty_destination_blocks_confirm(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        service = FakeCloneService(preflight=make_preflight(destination_ready=False))
        dispatcher = ManualDispatcher()
        dialog = CloneDialog(
            service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
        )
        qtbot.addWidget(dialog)
        dialog.show()
        _fill_https_form(dialog.form(), destination=str(tmp_path / "occupied"))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.status() is CreateFlowState.FAILED
        assert service.created == []
        assert not dialog.confirm_button().isEnabled()
        spoken = " ".join(widget.text() for widget in dialog.findChildren(QLabel))
        assert TEXTS.error_titles[ErrorCategory.DISK.value] in spoken


class TestPreflightState:
    """Given a valid form, preflight suspends Confirm until the verdict lands."""

    def test_preflighting_suspends_confirm(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, _service, dispatcher = clone_dialog
        _fill_https_form(dialog.form(), destination=str(tmp_path / "c"))
        dialog.request_plan()
        assert dialog.status() is CreateFlowState.PLANNING
        assert len(dispatcher.pending) == 1
        assert not dialog.confirm_button().isEnabled()
        assert dialog.confirm_reason() == TEXTS.confirm_reason_preflighting

    def test_ready_preflight_enables_confirm_and_renders_verdict(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        _fill_https_form(dialog.form(), destination=str(tmp_path / "c"))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.status() is CreateFlowState.PLANNED
        assert dialog.confirm_button().isEnabled()
        assert len(service.preflighted_destinations) == 1
        summary = dialog.preflight_summary()
        assert summary["git"] == "2.45.1"
        assert summary["xet"] == TEXTS.xet_configured
        assert summary["destination"] == TEXTS.destination_detail("destination.empty")
        assert summary["ready"] == TEXTS.ready_label

    def test_missing_git_xet_blocks_confirm_and_rechecks(
        self, qtbot: QtBot, tmp_path: Path
    ) -> None:
        service = FakeCloneService(
            preflight=make_preflight(
                ready=False,
                destination_ready=True,
                git_state=DependencyState.DEGRADED,
                xet_state=XetState.MISSING,
            )
        )
        dispatcher = ManualDispatcher()
        dialog = CloneDialog(
            service, TEXTS, ids=ControllableIdFactory(), dispatcher=dispatcher
        )
        qtbot.addWidget(dialog)
        dialog.show()
        _fill_https_form(dialog.form(), destination=str(tmp_path / "c"))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.status() is CreateFlowState.FAILED
        assert service.created == []
        assert not dialog.confirm_button().isEnabled()
        spoken = " ".join(widget.text() for widget in dialog.findChildren(QLabel))
        assert TEXTS.error_titles[ErrorCategory.DEPENDENCY.value] in spoken
        dialog.preflight_button().click()
        assert dialog.status() is CreateFlowState.PLANNING
        dispatcher.run_one()
        assert len(service.preflighted_destinations) == 2


class TestConfirmation:
    """Given a ready preflight, the exact typed payload reaches the service."""

    def test_https_enqueue_payload(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        target = tmp_path / "c"
        _fill_https_form(dialog.form(), destination=str(target))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.confirm()
        assert len(service.created) == 1
        _task_id, spec, _attempt_id = service.created[0]
        assert isinstance(spec, GitCloneSpec)
        assert spec.repository.repo_id == "org/repo"
        assert spec.destination == target
        assert spec.auth_source is AuthSource.ANONYMOUS
        assert spec.proxy_mode is ProxyMode.SYSTEM
        assert dialog.created_spec() is spec

    def test_ssh_url_derives_repository_identity(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        form = dialog.form()
        form.transport_segments().set_current(TransportChoice.SSH.value)
        form.ssh_url_field().set_text("git@hf.co:org/repo")
        target = tmp_path / "c"
        form.destination_field().set_text(str(target))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.confirm()
        spec = service.created[0][1]
        assert isinstance(spec, GitCloneSpec)
        assert spec.repository.repo_id == "org/repo"

    def test_shallow_selection_is_captured(
        self, clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher]
    ) -> None:
        dialog, _service, _dispatcher = clone_dialog
        form = dialog.form()
        form.shallow_field().box().setChecked(True)
        values = form.values()
        assert values.shallow is True

    def test_confirm_before_preflight_does_nothing(
        self, clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher]
    ) -> None:
        dialog, service, _dispatcher = clone_dialog
        assert not dialog.confirm()
        assert service.created == []

    def test_task_created_signal_carries_spec(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, _service, dispatcher = clone_dialog
        received: list[TaskSpec] = []
        dialog.task_created.connect(received.append)
        _fill_https_form(dialog.form(), destination=str(tmp_path / "c"))
        dialog.request_plan()
        dispatcher.run_one()
        dialog.confirm()
        assert len(received) == 1
        assert isinstance(received[0], GitCloneSpec)


class TestSecretsAndKeyboard:
    """Given a manual-token selection, no secret value ever appears."""

    def test_manual_token_source_leaves_no_secret_bytes(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        form = dialog.form()
        form.auth_combo().set_current_key(AuthSource.MANUAL_TOKEN.value)
        _fill_https_form(form, destination=str(tmp_path / "c"))
        dialog.request_plan()
        dispatcher.run_one()
        assert dialog.confirm()
        spec = service.created[0][1]
        assert spec.auth_source is AuthSource.MANUAL_TOKEN
        assert SENTINEL not in str(spec.model_dump())
        spoken = " ".join(widget.text() for widget in dialog.findChildren(QLabel))
        assert SENTINEL not in spoken

    def test_https_tab_sequence(
        self, clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher]
    ) -> None:
        dialog, _service, _dispatcher = clone_dialog
        form = dialog.form()
        form.repo_id_field().editor().setFocus()
        QTest.keyClick(dialog, Qt.Key.Key_Tab)
        assert QApplication.focusWidget() is form.revision_field().editor()
        QTest.keyClick(dialog, Qt.Key.Key_Tab)
        assert QApplication.focusWidget() is form.shallow_field().box()


class TestCancelledPreflight:
    """Given a dismissed dialog, a late preflight outcome is ignored."""

    def test_cancelled_preflight_never_creates(
        self,
        clone_dialog: tuple[CloneDialog, FakeCloneService, ManualDispatcher],
        tmp_path: Path,
    ) -> None:
        dialog, service, dispatcher = clone_dialog
        _fill_https_form(dialog.form(), destination=str(tmp_path / "c"))
        dialog.request_plan()
        dialog.close()
        dispatcher.run_one()
        assert service.created == []
