"""Transient Download creation dialog: planning, estimates, and enqueue.

# noqa: SIZE_OK - one dialog must own the whole download flow: the closed
# state machine, the estimate readout, planning off the GUI thread, inline
# failure rendering, and the confirmation command; splitting it would scatter
# one cohesive transient surface.

The dialog owns the closed :class:`CreateFlowState` machine. Planning runs off
the GUI thread through the injected :class:`WorkDispatcher`; while it runs the
plan command shows its loading state and Confirm is disabled with a
machine-readable accessible reason. A successful plan renders file/byte/cache/
disk estimates before Confirm is enabled; insufficient disk or a typed planning
failure shows one inline recovery action and never creates a task. The dialog
is standalone — the shell's ``create_download_requested`` signal launches it in
a later todo's composition root.
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
from hubfetch.hub.planner import DownloadPlan
from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets import common
from hubfetch.ui.widgets.blocks import ErrorBlock, LoadingBlock
from hubfetch.ui.widgets.buttons import ActionButton, IconButton
from hubfetch.ui.widgets.labels import CaptionLabel

from .contracts import (
    CreateFlowState,
    DownloadCreateService,
    TaskIdFactory,
    UuidTaskIdFactory,
    WorkDispatcher,
)
from .dispatch import ThreadPoolWorkDispatcher
from .download_form import DownloadForm
from .texts import format_bytes
from .validation import build_download_spec, validate_download_values

if TYPE_CHECKING:
    from collections.abc import Callable

    from PySide6.QtGui import QCloseEvent

    from hubfetch.domain.task_spec import TaskSpec

    from .texts import CreateTexts

    DirectoryPicker = Callable[[str], str]


@final
class DownloadDialog(QDialog):
    """One transient download creation flow over a typed service seam."""

    task_created = Signal(object)

    __slots__: Final = (
        "_closed",
        "_confirm",
        "_dispatcher",
        "_error_page",
        "_estimates_bytes",
        "_estimates_commit",
        "_estimates_disk",
        "_estimates_files",
        "_estimates_hits",
        "_estimates_misses",
        "_estimates_page",
        "_form",
        "_ids",
        "_loading",
        "_plan",
        "_plan_button",
        "_service",
        "_spec",
        "_state",
        "_status_stack",
        "_texts",
    )
    _service: DownloadCreateService
    _texts: CreateTexts
    _ids: TaskIdFactory
    _dispatcher: WorkDispatcher
    _state: CreateFlowState
    _plan_button: ActionButton
    _confirm: ActionButton
    _status_stack: QStackedWidget
    _error_page: ErrorBlock | None
    _loading: LoadingBlock
    _estimates_page: QWidget
    _estimates_commit: QLabel
    _estimates_files: QLabel
    _estimates_bytes: QLabel
    _estimates_hits: QLabel
    _estimates_misses: QLabel
    _estimates_disk: QLabel
    _plan: DownloadPlan | None
    _spec: TaskSpec | None
    _closed: bool

    def __init__(
        self,
        service: DownloadCreateService,
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
        self._plan = None
        self._spec = None
        self._error_page = None
        self._closed = False
        self.setWindowTitle(texts.download_title)
        self.setMinimumWidth(520)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_SM)
        header = QHBoxLayout()
        title = QLabel(texts.download_title)
        title_font = title.font()
        title_font.setBold(True)
        title.setFont(title_font)
        header.addWidget(title, stretch=1)
        close = IconButton(icons.IconName.X, accessible_name=texts.download_title)
        header.addWidget(close)
        layout.addLayout(header)
        self._form = DownloadForm(texts, directory_picker=directory_picker)
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(self._form)
        scroll.setMinimumHeight(300)
        layout.addWidget(scroll, stretch=1)
        self._loading = LoadingBlock(
            self._texts.planning_label, tokens.MotionPreference.REDUCED
        )
        self._status_stack = QStackedWidget(self)
        self._status_stack.addWidget(self._loading)
        (
            self._estimates_page,
            self._estimates_commit,
            self._estimates_files,
            self._estimates_bytes,
            self._estimates_hits,
            self._estimates_misses,
            self._estimates_disk,
        ) = self._build_estimates()
        self._status_stack.addWidget(self._estimates_page)
        self._status_stack.setCurrentWidget(self._estimates_page)
        layout.addWidget(self._status_stack)
        footer = QHBoxLayout()
        footer.setSpacing(tokens.SPACE_SM)
        self._plan_button = ActionButton(texts.plan_button)
        self._confirm = ActionButton(texts.confirm_download, primary=True)
        footer.addWidget(self._plan_button)
        footer.addStretch(1)
        footer.addWidget(self._confirm)
        layout.addLayout(footer)
        self._connect(close)
        self._refresh_controls()

    def status(self) -> CreateFlowState:
        """Return the closed state of this creation flow."""
        return self._state

    def service(self) -> DownloadCreateService:
        """Return the typed service seam this dialog plans and enqueues through."""
        return self._service

    def form(self) -> DownloadForm:
        """Return the download form body."""
        return self._form

    def plan_button(self) -> ActionButton:
        """Return the Plan command."""
        return self._plan_button

    def confirm_button(self) -> ActionButton:
        """Return the Confirm command."""
        return self._confirm

    def confirm_reason(self) -> str | None:
        """Return the machine-readable disabled reason of Confirm, if any."""
        return self._confirm.accessibleDescription() or None

    def plan_result(self) -> DownloadPlan | None:
        """Return the latest accepted plan, or ``None`` before one exists."""
        return self._plan

    def created_spec(self) -> TaskSpec | None:
        """Return the enqueued task specification, or ``None`` when not created."""
        return self._spec

    def plan_summary(self) -> dict[str, str]:
        """Return the rendered estimate summary for evidence and assertions."""
        plan = self._plan
        if plan is None:
            return {}
        return {
            "resolved_commit": plan.resolved_commit,
            "files": str(len(plan.selected_files)),
            "bytes": format_bytes(plan.total_bytes),
            "cache_hits": str(plan.cache_hits),
            "cache_misses": str(plan.cache_misses),
            "disk": self._disk_label(plan.space.sufficient),
            "destination": str(plan.destination),
        }

    def request_plan(self) -> None:
        """Validate the form and run planning off the GUI thread."""
        if self._state is CreateFlowState.PLANNING:
            return
        values = self._form.values()
        errors = validate_download_values(values)
        self._form.set_field_errors(errors)
        if errors:
            self._state = CreateFlowState.EDITING
            self._plan = None
            self._spec = None
            self._refresh_controls()
            return
        try:
            spec = build_download_spec(values)
        except ValueError as error:
            self._show_failure(error_for(ErrorCategory.VALIDATION, detail=str(error)))
            return
        self._spec = spec
        self._state = CreateFlowState.PLANNING
        self._plan = None
        self._status_stack.setCurrentWidget(self._loading)
        self._plan_button.set_loading(
            loading=True, loading_text=self._texts.plan_loading
        )
        self._refresh_controls()
        self._dispatcher.submit(
            lambda: self._service.plan(spec),
            self._on_plan_ready,
            self._on_plan_error,
        )

    def confirm(self) -> bool:
        """Enqueue the planned task; returns whether a task was created."""
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
        self._plan_button.clicked.connect(self.request_plan)
        self._confirm.clicked.connect(self.confirm)
        close.clicked.connect(self._on_closed)
        self.rejected.connect(self._on_closed)
        self._form.changed.connect(self._on_form_changed)

    def _on_form_changed(self) -> None:
        """Invalidate a stale plan whenever any field moves."""
        if self._state is not CreateFlowState.PLANNED:
            return
        self._state = CreateFlowState.EDITING
        self._plan = None
        self._spec = None
        self._status_stack.setCurrentWidget(self._estimates_page)
        self._confirm.set_disabled_reason(self._texts.confirm_reason_changed)

    def _on_plan_ready(self, result: object) -> None:
        """Apply a successful plan or fail on an insufficient-disk verdict."""
        if self._closed:
            return
        if not isinstance(result, DownloadPlan):
            self._on_plan_error(
                error_for(ErrorCategory.INTERNAL, detail="planner returned no plan")
            )
            return
        if result.space.sufficient is False:
            self._spec = None
            self._show_failure(
                error_for(
                    ErrorCategory.DISK,
                    detail=f"shortfall {result.space.shortfall_bytes} bytes",
                )
            )
            return
        self._plan = result
        self._state = CreateFlowState.PLANNED
        self._render_estimates(result)
        self._status_stack.setCurrentWidget(self._estimates_page)
        self._refresh_controls()

    def _on_plan_error(self, error: BaseException) -> None:
        """Show one inline recovery action for a typed planning failure."""
        if self._closed:
            return
        if isinstance(error, HubFetchError):
            self._show_failure(error)
        else:
            self._show_failure(error_for(ErrorCategory.INTERNAL, detail=str(error)))

    def _show_failure(self, error: HubFetchError) -> None:
        """Render the failure block and block Confirm with a typed reason."""
        self._state = CreateFlowState.FAILED
        self._plan = None
        self._spec = None
        self._plan_button.set_loading(False)
        self._plan_button.setText(self._texts.replan_button)
        if self._error_page is not None:
            self._status_stack.removeWidget(self._error_page)
            self._error_page.deleteLater()
        self._error_page = ErrorBlock(
            title=self._texts.error_title(error.spec.category),
            detail=error.detail or "",
            recovery_label=self._texts.recovery_label(error.spec.recovery_action),
        )
        self._status_stack.addWidget(self._error_page)
        self._status_stack.setCurrentWidget(self._error_page)
        self._refresh_controls()

    def _render_estimates(self, plan: DownloadPlan) -> None:
        """Fill the estimate readout from one accepted plan."""
        self._estimates_commit.setText(plan.resolved_commit)
        self._estimates_files.setText(str(len(plan.selected_files)))
        self._estimates_bytes.setText(format_bytes(plan.total_bytes))
        self._estimates_hits.setText(str(plan.cache_hits))
        self._estimates_misses.setText(str(plan.cache_misses))
        self._estimates_disk.setText(self._disk_label(plan.space.sufficient))

    def _disk_label(self, sufficient: bool | None) -> str:
        """Render the localized disk verdict for one space assessment."""
        match sufficient:
            case True:
                return self._texts.disk_sufficient
            case False:
                return self._texts.disk_insufficient
            case None:
                return self._texts.disk_unknown

    def _refresh_controls(self) -> None:
        """Align Confirm's enabled state and its accessible disabled reason."""
        match self._state:
            case CreateFlowState.EDITING:
                self._confirm.set_disabled_reason(self._texts.confirm_reason_plan)
            case CreateFlowState.PLANNING:
                self._confirm.set_disabled_reason(self._texts.confirm_reason_planning)
            case CreateFlowState.PLANNED:
                self._confirm.set_disabled_reason(None)
            case CreateFlowState.FAILED:
                self._confirm.set_disabled_reason(self._texts.confirm_reason_failed)

    def _build_estimates(
        self,
    ) -> tuple[QWidget, QLabel, QLabel, QLabel, QLabel, QLabel, QLabel]:
        """Compose the label/value estimate readout panel and its value labels."""
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
        commit = self._add_row(grid, self._texts.resolved_commit_label)
        files = self._add_row(grid, self._texts.files_label)
        total = self._add_row(grid, self._texts.bytes_label)
        hits = self._add_row(grid, self._texts.cache_hits_label)
        misses = self._add_row(grid, self._texts.cache_misses_label)
        disk = self._add_row(grid, self._texts.disk_label)
        return panel, commit, files, total, hits, misses, disk

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
        """Mark the dialog closed so late plan outcomes are ignored."""
        self._on_closed()
        super().closeEvent(event)

    def _on_closed(self) -> None:
        """Ignore any in-flight plan outcome after the dialog is dismissed."""
        self._closed = True


__all__ = ["DownloadDialog"]
