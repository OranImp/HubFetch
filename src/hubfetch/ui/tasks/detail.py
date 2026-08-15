"""Task detail view: identity, stage rail, progress, timeline, actions.

:class:`TaskDetailView` renders one immutable :class:`DetailSnapshot`: repo
identity and spec summary, queue position, attempt, destination/cache path, the
accessible transfer-stage rail, numeric/byte/speed progress, the sanitized
event timeline, the current recovery action, and Cancel/Retry/Open
Folder/Copy Diagnostic commands routed exclusively through
:class:`TaskActionModel`. The view never issues application commands itself;
all derivation logic lives in :mod:`hubfetch.ui.tasks.reading`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from PySide6.QtWidgets import (
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QVBoxLayout,
    QWidget,
)

from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.task_spec import GitCloneSpec, LocalDirectoryDestination
from hubfetch.ui import tokens
from hubfetch.ui.tasks.reading import ProgressReading, stage_reports
from hubfetch.ui.tasks.timeline import TaskTimeline
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.labels import CaptionLabel, ElidedLabel
from hubfetch.ui.widgets.progress import TransferProgressBar
from hubfetch.ui.widgets.stage_rail import TransferStageRail
from hubfetch.ui.widgets.status import InlineRecoveryAction, StatusPair, StatusSeverity

if TYPE_CHECKING:
    from hubfetch.application.snapshots import DetailSnapshot
    from hubfetch.domain.events import PersistedEvent
    from hubfetch.domain.ids import TaskId
    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.ui.tasks.actions import TaskActionModel
    from hubfetch.ui.tasks.texts import TaskTexts

_RETRYABLE_STATES: Final[frozenset[LifecycleState]] = frozenset(
    {
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
    }
)


class TaskDetailView(QWidget):
    """The flexible detail pane for one selected task."""

    def __init__(self, texts: TaskTexts, actions: TaskActionModel) -> None:
        """Build the full detail skeleton and wire buttons to the action model."""
        super().__init__()
        self._texts: TaskTexts = texts
        self._actions: TaskActionModel = actions
        self._detail: DetailSnapshot | None = None
        self._status: StatusPair = StatusPair(StatusSeverity.INFO, "")

        self._repo: ElidedLabel = ElidedLabel("")
        self._kind: CaptionLabel = CaptionLabel("")
        self._position: CaptionLabel = CaptionLabel("")
        self._attempt: CaptionLabel = CaptionLabel("")
        self._destination: ElidedLabel = ElidedLabel("")
        self._rail: TransferStageRail = TransferStageRail(texts.stage_labels)
        self._progress: TransferProgressBar = TransferProgressBar(texts.progress_label)
        self._timeline: TaskTimeline = TaskTimeline(texts.timeline_header)
        self._recovery: InlineRecoveryAction = InlineRecoveryAction(
            texts.recovery_message, texts.recovery_action
        )
        self._cancel: ActionButton = ActionButton(texts.cancel_command)
        self._retry: ActionButton = ActionButton(texts.retry_command)
        self._open_folder: ActionButton = ActionButton(texts.open_folder_command)
        self._copy_diag: ActionButton = ActionButton(texts.copy_diagnostic_command)

        self._build_layout()
        self._wire_actions()
        self._clear_fields()

    def _build_layout(self) -> None:
        """Compose the identity header, rail, progress, timeline, and commands."""
        identity = QHBoxLayout()
        identity.setSpacing(tokens.SPACE_SM)
        identity.addWidget(self._kind)
        identity.addWidget(self._repo, stretch=1)
        identity.addWidget(self._status)

        grid = QGridLayout()
        grid.setHorizontalSpacing(tokens.SPACE_MD)
        grid.setVerticalSpacing(tokens.SPACE_XS)
        grid.addWidget(QLabel(self._texts.destination_label), 0, 0)
        grid.addWidget(self._destination, 0, 1)
        grid.addWidget(QLabel(self._texts.progress_label), 1, 0)
        grid.addWidget(self._progress, 1, 1)
        grid.addWidget(QLabel(self._texts.attempt_format.split("{")[0].strip()), 2, 0)
        grid.addWidget(self._attempt, 2, 1)
        grid.setColumnStretch(1, 1)

        commands = QHBoxLayout()
        commands.setSpacing(tokens.SPACE_SM)
        commands.addWidget(self._cancel)
        commands.addWidget(self._retry)
        commands.addWidget(self._open_folder)
        commands.addWidget(self._copy_diag)
        commands.addStretch(1)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_MD)
        layout.addLayout(identity)
        layout.addLayout(grid)
        layout.addWidget(self._rail)
        layout.addWidget(self._recovery)
        layout.addWidget(self._timeline, stretch=1)
        layout.addLayout(commands)
        self._recovery.hide()

    def _wire_actions(self) -> None:
        """Route every command button through the action model only."""
        _ = self._cancel.clicked.connect(self._actions.request_cancel)
        _ = self._retry.clicked.connect(self._actions.request_retry)
        _ = self._open_folder.clicked.connect(self._actions.request_open_folder)
        _ = self._copy_diag.clicked.connect(self._actions.request_copy_diagnostic)
        _ = self._actions.actions_changed.connect(self._sync_action_state)

    def _clear_fields(self) -> None:
        """Reset every field to its empty placeholder."""
        self._repo.setText("")
        self._kind.setText("")
        self._status.text_label().setText("")
        self._position.setText("")
        self._attempt.setText("")
        self._destination.setText("")
        self._rail.set_reports(())
        self._progress.set_busy("—")
        self._timeline.set_events(())

    # -- snapshot application ------------------------------------------------

    def apply_detail(self, detail: DetailSnapshot) -> None:
        """Render one immutable detail snapshot into every pane."""
        self._detail = detail
        task = detail.task
        self._repo.setText(str(task.spec.repository.repo_id))
        self._kind.setText(self._texts.kind_texts.get(task.spec.kind, task.spec.kind))
        self._status.text_label().setText(self._texts.state_texts[task.state])
        self._position.setText(
            self._texts.queue_position_format.format(position=task.position)
        )
        self._attempt.setText(
            self._texts.attempt_format.format(attempt=task.attempt_id)
        )
        self._destination.setText(self._destination_text(task.spec))
        self._rail.set_reports(stage_reports(task.state, detail.events))
        self._sync_progress(detail.events)
        self._timeline.set_events(detail.events)
        self._sync_recovery(task.state)
        self._actions.apply_detail(detail)

    def _destination_text(self, spec: TaskSpec) -> str:
        """Render the destination or cache path text for the spec."""
        if isinstance(spec, GitCloneSpec):
            return str(spec.destination)
        destination = spec.destination
        if isinstance(destination, LocalDirectoryDestination):
            return str(destination.path)
        return self._texts.cache_label

    def _sync_progress(self, events: tuple[PersistedEvent, ...]) -> None:
        """Drive the progress bar from the two latest progress events."""
        reading = ProgressReading(events)
        if reading.fraction is not None:
            self._progress.set_progress(reading.fraction, reading.detail)
        else:
            self._progress.set_busy(reading.detail)

    def _sync_recovery(self, state: LifecycleState) -> None:
        """Show the recovery action only when the state is retryable."""
        if state in _RETRYABLE_STATES:
            self._recovery.show()
        else:
            self._recovery.hide()

    # -- action-state sync ----------------------------------------------------

    def _sync_action_state(self) -> None:
        """Enable/disable command buttons from the action model's truth."""
        actions = self._actions
        self._cancel.setEnabled(actions.can_cancel() or actions.cancelling_active())
        if actions.cancelling_active():
            self._cancel.setText(self._texts.cancelling_label)
            self._cancel.setAccessibleDescription(self._texts.cancelling_label)
        else:
            self._cancel.setText(self._texts.cancel_command)
            self._cancel.setAccessibleDescription("")
        self._retry.setEnabled(actions.can_retry())
        if actions.retry_needs_destination():
            self._retry.setEnabled(False)
            self._retry.setAccessibleDescription(
                self._texts.destination_required_message
            )
        self._open_folder.setEnabled(actions.can_open_folder())
        self._copy_diag.setEnabled(actions.can_copy_diagnostic())

    # -- test/QA accessors ----------------------------------------------------

    def rail(self) -> TransferStageRail:
        """Expose the stage rail for accessibility assertions."""
        return self._rail

    def progress_bar(self) -> TransferProgressBar:
        """Expose the progress bar for numeric assertions."""
        return self._progress

    def timeline(self) -> TaskTimeline:
        """Expose the sanitized timeline."""
        return self._timeline

    def recovery(self) -> InlineRecoveryAction:
        """Expose the recovery action."""
        return self._recovery

    def cancel_button(self) -> ActionButton:
        """Expose the Cancel command button."""
        return self._cancel

    def retry_button(self) -> ActionButton:
        """Expose the Retry command button."""
        return self._retry

    def open_folder_button(self) -> ActionButton:
        """Expose the Open Folder command button."""
        return self._open_folder

    def copy_diagnostic_button(self) -> ActionButton:
        """Expose the Copy Diagnostic command button."""
        return self._copy_diag

    def state_text(self) -> str:
        """Return the current state text for evidence capture."""
        return self._status.text_label().text()

    def destination_text(self) -> str:
        """Return the rendered destination/cache path text."""
        return self._destination.full_text()

    def current_task_id(self) -> TaskId | None:
        """Return the rendered task id, if any."""
        if self._detail is None:
            return None
        return self._detail.task.task_id


__all__ = ["TaskDetailView"]
