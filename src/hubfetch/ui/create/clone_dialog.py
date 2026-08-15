"""Transient Clone creation dialog: preflight, empty-destination rule, enqueue.

# noqa: SIZE_OK - one dialog must own the whole clone flow: the closed state
# machine, the Git/Git-Xet verdict readout, preflight off the GUI thread, the
# recheck recovery action, and the confirmation command; splitting it would
# scatter one cohesive transient surface.

The dialog owns the closed :class:`CreateFlowState` machine. Preflight runs
Todo 12 dependency readiness and Todo 19's absent-or-empty destination rule off
the GUI thread through the injected :class:`WorkDispatcher`; while it runs the
preflight command shows its loading state and Confirm is disabled with a
machine-readable accessible reason. A ready result renders the Git/Git-Xet and
destination verdict before Confirm is enabled; a missing dependency or a
non-empty destination shows one inline recovery action that re-runs preflight
and never creates a task.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final, override

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from hubfetch.domain.errors import ErrorCategory, HubFetchError, error_for
from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.blocks import ErrorBlock, LoadingBlock
from hubfetch.ui.widgets.buttons import ActionButton, IconButton
from hubfetch.ui.widgets.labels import CaptionLabel

from .clone_form import CloneForm
from .contracts import (
    CloneCreateService,
    ClonePreflight,
    CreateFlowState,
    TaskIdFactory,
    UuidTaskIdFactory,
    WorkDispatcher,
)
from .dispatch import ThreadPoolWorkDispatcher
from .validation import build_clone_spec, validate_clone_values

if TYPE_CHECKING:
    from collections.abc import Callable

    from PySide6.QtGui import QCloseEvent

    from hubfetch.domain.task_spec import TaskSpec

    from .texts import CreateTexts

    DirectoryPicker = Callable[[str], str]


@final
class CloneDialog(QDialog):
    """One transient clone creation flow over a typed service seam."""

    task_created = Signal(object)

    __slots__: Final = (
        "_closed",
        "_confirm",
        "_destination_check",
        "_dispatcher",
        "_error_page",
        "_form",
        "_git_version",
        "_ids",
        "_loading",
        "_preflight",
        "_preflight_button",
        "_ready_state",
        "_service",
        "_spec",
        "_state",
        "_status_stack",
        "_summary_page",
        "_texts",
        "_xet_state",
    )
    _service: CloneCreateService
    _texts: CreateTexts
    _ids: TaskIdFactory
    _dispatcher: WorkDispatcher
    _state: CreateFlowState
    _preflight_button: ActionButton
    _confirm: ActionButton
    _status_stack: QStackedWidget
    _error_page: ErrorBlock | None
    _loading: LoadingBlock
    _summary_page: QWidget
    _git_version: QLabel
    _xet_state: QLabel
    _destination_check: QLabel
    _ready_state: QLabel
    _preflight: ClonePreflight | None
    _spec: TaskSpec | None
    _closed: bool

    def __init__(
        self,
        service: CloneCreateService,
        texts: CreateTexts,
        *,
        ids: TaskIdFactory | None = None,
        dispatcher: WorkDispatcher | None = None,
        directory_picker: DirectoryPicker | None = None,
    ) -> None:
        """Compose title, scrollable form, status region, and ordered footer."""
        super().__init__()
        self._service = service
        self._texts = texts
        self._ids = ids if ids is not None else UuidTaskIdFactory()
        self._dispatcher = (
            dispatcher if dispatcher is not None else ThreadPoolWorkDispatcher()
        )
        self._state = CreateFlowState.EDITING
        self._preflight = None
        self._spec = None
        self._error_page = None
        self._closed = False
        self.setWindowTitle(texts.clone_title)
        self.setMinimumWidth(520)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_SM)
        header = QHBoxLayout()
        title = QLabel(texts.clone_title)
        title_font = title.font()
        title_font.setBold(True)
        title.setFont(title_font)
        header.addWidget(title, stretch=1)
        close = IconButton(icons.IconName.X, accessible_name=texts.clone_title)
        header.addWidget(close)
        layout.addLayout(header)
        self._form = CloneForm(texts, directory_picker=directory_picker)
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(self._form)
        scroll.setMinimumHeight(280)
        layout.addWidget(scroll, stretch=1)
        self._loading = LoadingBlock(
            self._texts.preflight_label, tokens.MotionPreference.REDUCED
        )
        self._status_stack = QStackedWidget(self)
        self._status_stack.addWidget(self._loading)
        (
            self._summary_page,
            self._git_version,
            self._xet_state,
            self._destination_check,
            self._ready_state,
        ) = self._build_summary()
        self._status_stack.addWidget(self._summary_page)
        self._status_stack.setCurrentWidget(self._summary_page)
        layout.addWidget(self._status_stack)
        footer = QHBoxLayout()
        footer.setSpacing(tokens.SPACE_SM)
        self._preflight_button = ActionButton(texts.replan_button)
        self._confirm = ActionButton(texts.confirm_clone, primary=True)
        footer.addWidget(self._preflight_button)
        footer.addStretch(1)
        footer.addWidget(self._confirm)
        layout.addLayout(footer)
        self._connect(close)
        self._refresh_controls()

    def status(self) -> CreateFlowState:
        """Return the closed state of this creation flow."""
        return self._state

    def form(self) -> CloneForm:
        """Return the clone form body."""
        return self._form

    def preflight_button(self) -> ActionButton:
        """Return the Preflight command."""
        return self._preflight_button

    def confirm_button(self) -> ActionButton:
        """Return the Confirm command."""
        return self._confirm

    def confirm_reason(self) -> str | None:
        """Return the machine-readable disabled reason of Confirm, if any."""
        return self._confirm.accessibleDescription() or None

    def preflight_result(self) -> ClonePreflight | None:
        """Return the latest accepted preflight, or ``None`` before one exists."""
        return self._preflight

    def created_spec(self) -> TaskSpec | None:
        """Return the enqueued task specification, or ``None`` when not created."""
        return self._spec

    def preflight_summary(self) -> dict[str, str]:
        """Return the rendered preflight verdict for evidence and assertions."""
        preflight = self._preflight
        if preflight is None:
            return {}
        return {
            "git": preflight.git.git_version or "",
            "xet": self._texts.xet_state(preflight.git.xet.state.value),
            "destination": self._texts.destination_detail(preflight.destination.detail),
            "ready": self._texts.ready_label
            if preflight.ready
            else self._texts.not_ready_label,
        }

    def request_plan(self) -> None:
        """Validate the form and run preflight off the GUI thread."""
        if self._state is CreateFlowState.PLANNING:
            return
        values = self._form.values()
        errors = validate_clone_values(values)
        self._form.set_field_errors(errors)
        if errors:
            self._state = CreateFlowState.EDITING
            self._preflight = None
            self._refresh_controls()
            return
        try:
            spec = build_clone_spec(values)
        except ValueError as error:
            self._show_failure(error_for(ErrorCategory.VALIDATION, detail=str(error)))
            return
        self._spec = spec
        self._state = CreateFlowState.PLANNING
        self._preflight = None
        self._status_stack.setCurrentWidget(self._loading)
        self._preflight_button.set_loading(
            loading=True, loading_text=self._texts.preflight_label
        )
        self._refresh_controls()
        destination = spec.destination
        self._dispatcher.submit(
            lambda: self._service.preflight(destination),
            self._on_preflight_ready,
            self._on_preflight_error,
        )

    def confirm(self) -> bool:
        """Enqueue the preflighted clone; returns whether a task was created."""
        if self._state is not CreateFlowState.PLANNED or self._spec is None:
            return False
        spec = self._spec
        task_id = self._ids.new_task_id()
        attempt_id = self._ids.new_attempt_id()
        _ = self._service.create(task_id, spec, attempt_id)
        self._spec = spec
        self.task_created.emit(spec)
        self.accept()
        return True

    def _connect(self, close: IconButton) -> None:
        """Wire commands, the form's change signal, and close handling."""
        self._preflight_button.clicked.connect(self.request_plan)
        self._confirm.clicked.connect(self.confirm)
        close.clicked.connect(self._on_closed)
        self.rejected.connect(self._on_closed)
        self._form.changed.connect(self._on_form_changed)

    def _on_form_changed(self) -> None:
        """Invalidate a stale preflight whenever any field moves."""
        if self._state is not CreateFlowState.PLANNED:
            return
        self._state = CreateFlowState.EDITING
        self._preflight = None
        self._spec = None
        self._status_stack.setCurrentWidget(self._summary_page)
        self._confirm.set_disabled_reason(self._texts.confirm_reason_changed)

    def _on_preflight_ready(self, result: object) -> None:
        """Render the verdict, or fail with a stage-specific recovery action."""
        if self._closed:
            return
        if not isinstance(result, ClonePreflight):
            self._on_preflight_error(
                error_for(ErrorCategory.INTERNAL, detail="preflight returned no report")
            )
            return
        if not result.ready:
            if not result.destination.ready:
                error = error_for(ErrorCategory.DISK, detail=result.destination.detail)
            else:
                guidance = "; ".join(result.guidance) or "dependency not ready"
                error = error_for(ErrorCategory.DEPENDENCY, detail=guidance)
            self._show_failure(error)
            return
        self._preflight = result
        self._state = CreateFlowState.PLANNED
        self._render_summary(result)
        self._status_stack.setCurrentWidget(self._summary_page)
        self._refresh_controls()

    def _on_preflight_error(self, error: BaseException) -> None:
        """Show one inline recovery action for a typed preflight failure."""
        if self._closed:
            return
        if isinstance(error, HubFetchError):
            self._show_failure(error)
        else:
            self._show_failure(error_for(ErrorCategory.INTERNAL, detail=str(error)))

    def _show_failure(self, error: HubFetchError) -> None:
        """Render the failure block and block Confirm with a typed reason."""
        self._state = CreateFlowState.FAILED
        self._preflight = None
        self._spec = None
        self._preflight_button.set_loading(False)
        if self._error_page is not None:
            self._status_stack.removeWidget(self._error_page)
            self._error_page.deleteLater()
        self._error_page = ErrorBlock(
            title=self._texts.error_title(error.spec.category),
            detail=error.detail or "",
            recovery_label=self._texts.replan_button,
        )
        self._error_page.recovery_action().triggered.connect(self.request_plan)
        self._status_stack.addWidget(self._error_page)
        self._status_stack.setCurrentWidget(self._error_page)
        self._refresh_controls()

    def _render_summary(self, preflight: ClonePreflight) -> None:
        """Fill the preflight verdict readout from one ready report."""
        self._git_version.setText(preflight.git.git_version or "")
        self._xet_state.setText(self._texts.xet_state(preflight.git.xet.state.value))
        self._destination_check.setText(
            self._texts.destination_detail(preflight.destination.detail)
        )
        self._ready_state.setText(
            self._texts.ready_label if preflight.ready else self._texts.not_ready_label
        )

    def _refresh_controls(self) -> None:
        """Align Confirm's enabled state and its accessible disabled reason."""
        match self._state:
            case CreateFlowState.EDITING:
                self._confirm.set_disabled_reason(self._texts.confirm_reason_preflight)
            case CreateFlowState.PLANNING:
                self._confirm.set_disabled_reason(
                    self._texts.confirm_reason_preflighting
                )
            case CreateFlowState.PLANNED:
                self._confirm.set_disabled_reason(None)
            case CreateFlowState.FAILED:
                self._confirm.set_disabled_reason(self._texts.confirm_reason_failed)

    def _build_summary(self) -> tuple[QWidget, QLabel, QLabel, QLabel, QLabel]:
        """Compose the label/value preflight verdict panel."""
        panel = QFrame(self)
        colors = common.semantic_colors(self.palette())
        sheet = (
            "QFrame { background-color: "
            + colors.surface
            + "; border: 1px solid "
            + colors.border
            + "; border-radius: "
            + str(tokens.RADIUS_CONTROL)
            + "px; }"
        )
        panel.setStyleSheet(sheet)
        grid = QVBoxLayout(panel)
        grid.setContentsMargins(
            tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM
        )
        grid.setSpacing(tokens.SPACE_XS)
        git = self._add_row(grid, self._texts.git_version_label)
        xet = self._add_row(grid, self._texts.xet_state_label)
        destination = self._add_row(grid, self._texts.destination_verdict_label)
        ready = self._add_row(grid, self._texts.ready_label)
        return panel, git, xet, destination, ready

    def _add_row(self, grid: QVBoxLayout, label: str) -> QLabel:
        """Add one label/value row and return its value label."""
        row = QHBoxLayout()
        row.setSpacing(tokens.SPACE_SM)
        name = CaptionLabel(label)
        value = CaptionLabel("")
        row.addWidget(name)
        row.addStretch(1)
        row.addWidget(value)
        grid.addLayout(row)
        return value

    @override
    def closeEvent(self, event: QCloseEvent) -> None:
        """Mark the dialog closed so late preflight outcomes are ignored."""
        self._on_closed()
        super().closeEvent(event)

    def _on_closed(self) -> None:
        """Ignore any in-flight preflight outcome after the dialog is dismissed."""
        self._closed = True


__all__ = ["CloneDialog"]
