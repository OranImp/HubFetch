"""Responsive application shell composing the runtime, navigation, and panes.

# noqa: SIZE_OK - one window must own the whole shell composition: the four
# destination work surfaces (Tasks, Cache, Diagnostics, Settings), the three
# responsive modes, the native menu, the detail pane, geometry persistence and
# clamping, and the runtime wiring; splitting it would scatter one cohesive
# surface across modules.

Todo 24 composes the desktop shell from Todo 21's immutable snapshots/commands
and Todo 23's primitives (DESIGN.md Section 8). The window routes the four
closed destinations to their real work surfaces (Tasks restores the queue,
Cache/Diagnostics/Settings show their composed views), reflows at 760/1180
effective pixels, gives each list/detail region one scroll owner, persists its
geometry clamped to the current screens, and exposes the native New Download /
New Clone / Settings / Refresh / optional Help commands. Every transfer stays
out of the GUI thread; the runtime's snapshot commands are the only reads.
"""

from __future__ import annotations

from enum import StrEnum, unique
from typing import TYPE_CHECKING, Final, final, override

from PySide6.QtCore import QRect, QSize, Qt, QUrl, Signal
from PySide6.QtGui import (
    QAction,
    QCloseEvent,
    QDesktopServices,
    QFont,
    QGuiApplication,
    QKeySequence,
    QResizeEvent,
    QShowEvent,
)
from PySide6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QMainWindow,
    QScrollArea,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from hubfetch.domain.events import TransferProgressedEvent
from hubfetch.domain.ids import TaskId, parse_task_id
from hubfetch.persistence.records import TaskNotFoundError
from hubfetch.ui import fonts, tokens
from hubfetch.ui.cache.texts import CacheViewTexts
from hubfetch.ui.cache.view import CacheView
from hubfetch.ui.create import (
    CloneCreateService,
    CloneDialog,
    CreateTexts,
    DownloadCreateService,
    DownloadDialog,
)
from hubfetch.ui.create.services import RuntimeCloneService, RuntimeDownloadService
from hubfetch.ui.diagnostics.texts import DiagnosticsViewTexts
from hubfetch.ui.diagnostics.view import DiagnosticsView
from hubfetch.ui.navigation import (
    Destination,
    NavigationModel,
    NavigationPane,
    ShellTexts,
)
from hubfetch.ui.settings.texts import SettingsViewTexts
from hubfetch.ui.settings.view import SettingsView
from hubfetch.ui.task_list import TaskListPane
from hubfetch.ui.task_selection import TaskSelection, make_back_button, restore_focus
from hubfetch.ui.widgets.blocks import EmptyBlock
from hubfetch.ui.widgets.common import semantic_colors
from hubfetch.ui.widgets.labels import CaptionLabel, ElidedLabel
from hubfetch.ui.widgets.progress import TransferProgressBar
from hubfetch.ui.widgets.status import StatusPair, StatusSeverity

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from datetime import datetime

    from hubfetch.application.bootstrap import DegradedDiagnostic
    from hubfetch.application.runtime import Runtime
    from hubfetch.application.snapshots import DetailSnapshot
    from hubfetch.config.settings import Settings
    from hubfetch.ui.widgets.buttons import IconButton

__all__ = [
    "MainWindow",
    "ShellMode",
    "TaskDetailPane",
    "clamp_frame_to_available",
]

_DEFAULT_WINDOW_SIZE: Final[QSize] = QSize(tokens.BREAKPOINT_WIDE, 760)
"""Startup geometry when no persisted geometry exists or is unusable."""

_UNBOUNDED: Final = 16777215
"""Qt's QWIDGETSIZE_MAX sentinel; clears a widget's fixed maximum width."""


def _mode_for_width(width: int) -> ShellMode:
    """Map an effective width to its DESIGN.md 8.2 shell mode."""
    if width < tokens.BREAKPOINT_MEDIUM:
        return ShellMode.NARROW
    if width < tokens.BREAKPOINT_WIDE:
        return ShellMode.MEDIUM
    return ShellMode.WIDE


_TIMESTAMP_FORMAT: Final = "%Y-%m-%d %H:%M"


@unique
class ShellMode(StrEnum):
    """Responsive shell modes keyed to DESIGN.md Section 8.2 breakpoints."""

    NARROW = "narrow"
    MEDIUM = "medium"
    WIDE = "wide"


def clamp_frame_to_available(frame: QRect, available: Sequence[QRect]) -> QRect:
    """Clamp a window frame into the union of current screen geometry.

    The frame's size is capped to the containing screen (or the primary screen
    when the frame center sits off every screen) and its position is shifted so
    the whole frame lands inside that screen. This guarantees a persisted
    off-screen geometry can never hide the window after restore.
    """
    if not available:
        return frame
    containing = next(
        (rect for rect in available if rect.contains(frame.center())),
        available[0],
    )
    width = min(frame.width(), containing.width())
    height = min(frame.height(), containing.height())
    x = frame.x()
    y = frame.y()
    if width >= containing.width() or x < containing.left():
        x = containing.left()
    elif x + width > containing.right():
        x = containing.right() - width
    if height >= containing.height() or y < containing.top():
        y = containing.top()
    elif y + height > containing.bottom():
        y = containing.bottom() - height
    return QRect(x, y, width, height)


def _format_timestamp(timestamp: datetime) -> str:
    """Render one aware datetime into a compact local display value."""
    return timestamp.astimezone().strftime(_TIMESTAMP_FORMAT)


@final
class TaskDetailPane(QFrame):
    """The flexible detail region: one snapshot, empty, or pending notice.

    The pane owns its single scroll region and exposes the explicit back icon
    command that narrow mode shows above the content (DESIGN.md 8.2). Progress
    is derived from the latest immutable ``transfer_progressed`` event so the
    detail never polls workers or the GUI thread.
    """

    back_requested = Signal()

    __slots__: Final = (
        "_back",
        "_content",
        "_content_layout",
        "_created",
        "_empty",
        "_kind",
        "_pending",
        "_position",
        "_progress",
        "_repo",
        "_scroll",
        "_showing_pending",
        "_showing_snapshot",
        "_stack",
        "_state",
        "_texts",
    )
    _texts: ShellTexts
    _back: IconButton
    _scroll: QScrollArea
    _content: QWidget
    _content_layout: QVBoxLayout
    _repo: ElidedLabel
    _kind: CaptionLabel
    _state: StatusPair
    _position: CaptionLabel
    _created: CaptionLabel
    _progress: TransferProgressBar
    _empty: EmptyBlock
    _pending: EmptyBlock | None
    _stack: QStackedWidget
    _showing_snapshot: bool
    _showing_pending: bool

    def __init__(self, texts: ShellTexts) -> None:
        """Compose the header, the single scroll owner, and the state blocks."""
        super().__init__()
        self._texts = texts
        colors = semantic_colors(self.palette())
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setStyleSheet(
            "QFrame { background-color: " + colors.surface + "; border: none; }"
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        layout.setSpacing(tokens.SPACE_MD)
        self._back = make_back_button(texts)
        self._back.setVisible(False)
        _ = self._back.clicked.connect(self.back_requested.emit)
        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.addWidget(self._back)
        header.addStretch(1)
        layout.addLayout(header)
        self._scroll = self._build_scroll()
        self._content = QWidget()
        self._content_layout = QVBoxLayout(self._content)
        self._content_layout.setContentsMargins(0, 0, 0, 0)
        self._content_layout.setSpacing(tokens.SPACE_SM)
        self._build_content(texts)
        self._scroll.setWidget(self._content)
        self._empty = EmptyBlock(
            texts.detail_empty_title, texts.detail_empty_description
        )
        self._stack = QStackedWidget(self)
        self._stack.addWidget(self._scroll)
        self._stack.addWidget(self._empty)
        self._pending = None
        self._showing_snapshot = False
        self._showing_pending = False
        layout.addWidget(self._stack, stretch=1)
        self.setAccessibleName(texts.tasks_header)

    def _build_scroll(self) -> QScrollArea:
        """Create the single detail scroll owner with no horizontal overflow."""
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        # A scroll owner must never force the shell wider than its viewport.
        scroll.setMinimumSize(0, 0)
        return scroll

    def _build_content(self, texts: ShellTexts) -> None:
        """Compose the immutable snapshot readout widgets in reading order."""
        self._repo = ElidedLabel("")
        repo_font = self._repo.font()
        repo_font.setWeight(QFont.Weight.DemiBold)
        self._repo.setFont(repo_font)
        self._content_layout.addWidget(self._repo)
        self._kind = CaptionLabel("")
        self._state = StatusPair(StatusSeverity.INFO, "")
        self._position = CaptionLabel("")
        self._created = CaptionLabel("")
        self._progress = TransferProgressBar(texts.progress_label)
        self._content_layout.addWidget(self._kind)
        self._content_layout.addWidget(self._state)
        self._content_layout.addWidget(self._position)
        self._content_layout.addWidget(self._created)
        self._content_layout.addWidget(self._progress)
        self._content_layout.addStretch(1)

    def show_snapshot(self, detail: DetailSnapshot) -> None:
        """Render one immutable detail snapshot into the content region."""
        self._showing_snapshot = True
        self._showing_pending = False
        task = detail.task
        self._repo.setText(task.spec.repository.repo_id)
        self._repo.setAccessibleName(task.spec.repository.repo_id)
        self._kind.setText(
            self._texts.kind_label + " " + self._texts.kind_text(task.spec.kind)
        )
        self._replace_state(
            self._texts.state_severity(task.state), self._texts.state_text(task.state)
        )
        self._position.setText(
            self._texts.queue_position_label + " " + str(task.position)
        )
        self._created.setText(
            self._texts.created_label + " " + _format_timestamp(task.created_at)
        )
        self._apply_progress(detail)
        self._stack.setCurrentWidget(self._scroll)

    def show_pending(self, title: str, description: str) -> None:
        """Show the honest not-yet-available notice for one surface."""
        self._showing_snapshot = False
        self._showing_pending = True
        if self._pending is not None:
            self._stack.removeWidget(self._pending)
            self._pending.deleteLater()
        self._pending = EmptyBlock(title, description)
        self._stack.addWidget(self._pending)
        self._stack.setCurrentWidget(self._pending)

    def clear(self) -> None:
        """Return to the empty (no-task-selected) state."""
        self._showing_snapshot = False
        self._showing_pending = False
        self._stack.setCurrentWidget(self._empty)

    def is_showing_snapshot(self) -> bool:
        """Return whether a task snapshot currently owns the pane."""
        return self._showing_snapshot

    def is_showing_pending(self) -> bool:
        """Return whether a pending notice currently owns the pane."""
        return self._showing_pending

    def repository_label(self) -> ElidedLabel:
        """Expose the elided repository identity for assertions."""
        return self._repo

    def scroll_area(self) -> QScrollArea:
        """Expose the single detail scroll owner for geometry assertions."""
        return self._scroll

    def back_button(self) -> IconButton:
        """Expose the narrow-mode back icon command."""
        return self._back

    def set_back_visible(self, visible: bool) -> None:
        """Show the back command only below the 760 px breakpoint."""
        self._back.setVisible(visible)

    def restore_focus(self) -> None:
        """Restore keyboard focus to the detail content."""
        restore_focus(self._scroll, self._back)

    def _replace_state(self, severity: StatusSeverity, text: str) -> None:
        """Swap the state pair for one with the current severity and text."""
        self._content_layout.replaceWidget(self._state, StatusPair(severity, text))
        self._state.deleteLater()
        self._state = StatusPair(severity, text)
        self._state.setAccessibleName(text)

    def _apply_progress(self, detail: DetailSnapshot) -> None:
        """Show byte progress from the latest immutable progress event."""
        latest: TransferProgressedEvent | None = None
        for event in detail.events:
            if isinstance(event, TransferProgressedEvent):
                latest = event
        if latest is None or latest.bytes_total <= 0:
            self._progress.hide()
            return
        fraction = latest.bytes_done / latest.bytes_total
        self._progress.set_progress(fraction, f"{int(fraction * 100)}%")
        self._progress.show()


@final
class MainWindow(QMainWindow):
    """The responsive HubFetch desktop shell over one composed runtime."""

    create_download_requested = Signal()
    """Emitted when the New Download command fires; opens the download dialog."""

    create_clone_requested = Signal()
    """Emitted when the New Clone command fires; opens the clone dialog."""

    refresh_requested = Signal()
    """Emitted whenever the Refresh command asks the shell to reload snapshots."""

    help_requested = Signal()
    """Emitted when the configured Help command opens its URL."""

    __slots__: Final = (
        "_cache_view",
        "_clone_dialog",
        "_clone_service",
        "_content_stack",
        "_create_texts",
        "_degraded",
        "_detail",
        "_diagnostics_view",
        "_download_dialog",
        "_download_service",
        "_help_action",
        "_list",
        "_mode",
        "_model",
        "_nav",
        "_new_clone_action",
        "_new_download_action",
        "_refresh_action",
        "_runtime",
        "_save_settings",
        "_selection",
        "_settings",
        "_settings_action",
        "_settings_view",
        "_tasks_page",
        "_texts",
    )
    _runtime: Runtime
    _settings: Settings
    _texts: ShellTexts
    _save_settings: Callable[[Settings], None]
    _degraded: tuple[DegradedDiagnostic, ...]
    _create_texts: CreateTexts
    _download_service: DownloadCreateService
    _clone_service: CloneCreateService
    _download_dialog: DownloadDialog | None
    _clone_dialog: CloneDialog | None
    _model: NavigationModel
    _selection: TaskSelection
    _nav: NavigationPane
    _list: TaskListPane
    _detail: TaskDetailPane
    _tasks_page: QWidget
    _content_stack: QStackedWidget
    _cache_view: CacheView
    _diagnostics_view: DiagnosticsView
    _settings_view: SettingsView
    _mode: ShellMode
    _new_download_action: QAction
    _new_clone_action: QAction
    _refresh_action: QAction
    _settings_action: QAction
    _help_action: QAction | None

    def __init__(
        self,
        *,
        runtime: Runtime,
        settings: Settings,
        texts: ShellTexts,
        save_settings: Callable[[Settings], None],
        degraded: tuple[DegradedDiagnostic, ...] = (),
    ) -> None:
        """Compose the shell, restore geometry, and load the first snapshot."""
        super().__init__()
        self._runtime = runtime
        self._settings = settings
        self._texts = texts
        self._save_settings = save_settings
        self._degraded = degraded
        self._mode = ShellMode.WIDE
        self.setWindowTitle(texts.window_title)
        self.setFont(fonts.ui_font(tokens.BODY_SIZE))
        self._create_texts = CreateTexts.for_locale(settings.locale)
        self._download_service = RuntimeDownloadService(runtime, settings)
        self._clone_service = RuntimeCloneService(runtime)
        self._download_dialog = None
        self._clone_dialog = None
        self._model = NavigationModel(texts, settings.help_url)
        self._selection = TaskSelection(self)
        self._nav = NavigationPane(self._model)
        self._list = TaskListPane(texts)
        self._detail = TaskDetailPane(texts)
        self._cache_view = CacheView(
            CacheViewTexts.for_locale(settings.locale), settings=settings
        )
        self._diagnostics_view = DiagnosticsView(
            DiagnosticsViewTexts.for_locale(settings.locale), settings=settings
        )
        self._settings_view = SettingsView(
            SettingsViewTexts.for_locale(settings.locale),
            settings=settings,
            save_settings=save_settings,
        )
        self._build_menu()
        self._build_central()
        self._connect()
        self._apply_degraded_banner()
        self._restore_geometry()
        self.refresh()

    def current_destination(self) -> Destination:
        """Return the destination the shell currently shows."""
        return self._model.current_destination()

    def navigation_model(self) -> NavigationModel:
        """Return the navigation routing model."""
        return self._model

    def navigation_pane(self) -> NavigationPane:
        """Return the rendered navigation pane."""
        return self._nav

    def task_list_pane(self) -> TaskListPane:
        """Return the task queue list pane."""
        return self._list

    def detail_pane(self) -> TaskDetailPane:
        """Return the flexible detail pane."""
        return self._detail

    def cache_view(self) -> CacheView:
        """Return the Cache work surface shown by the Cache destination."""
        return self._cache_view

    def diagnostics_view(self) -> DiagnosticsView:
        """Return the Diagnostics work surface shown by its destination."""
        return self._diagnostics_view

    def settings_view(self) -> SettingsView:
        """Return the Settings work surface shown by its destination."""
        return self._settings_view

    def content_stack(self) -> QStackedWidget:
        """Return the four-destination content stack for routing assertions."""
        return self._content_stack

    def task_selection(self) -> TaskSelection:
        """Return the selection/back model."""
        return self._selection

    def shell_mode(self) -> ShellMode:
        """Return the responsive mode for the current width."""
        return self._mode

    def new_download_action(self) -> QAction:
        """Return the native New Download menu action."""
        return self._new_download_action

    def new_clone_action(self) -> QAction:
        """Return the native New Clone menu action."""
        return self._new_clone_action

    def refresh_action(self) -> QAction:
        """Return the native Refresh menu action."""
        return self._refresh_action

    def settings_action(self) -> QAction:
        """Return the native Settings menu action."""
        return self._settings_action

    def help_action(self) -> QAction | None:
        """Return the native Help action, or ``None`` when no URL is configured."""
        return self._help_action

    def download_create_service(self) -> DownloadCreateService:
        """Return the runtime-backed service wired to the download dialog."""
        return self._download_service

    def clone_create_service(self) -> CloneCreateService:
        """Return the runtime-backed service wired to the clone dialog."""
        return self._clone_service

    def refresh(self) -> None:
        """Reload the queue snapshot and the selected detail from the runtime."""
        snapshot = self._runtime.snapshot()
        self._list.set_snapshot(snapshot)
        selected = self._selection.selected_task_id()
        if selected is not None:
            self._refresh_detail(selected)
        else:
            self._detail.clear()
        # Focus only owns the visible Tasks surface; Cache/Diagnostics/Settings
        # keep the focus they restored when they were routed to.
        if (
            self._mode is not ShellMode.NARROW
            and self.current_destination() is Destination.TASKS
        ):
            self._list.focus_selection()

    @override
    def resizeEvent(self, event: QResizeEvent) -> None:
        """Reflow the panes whenever the effective width crosses a breakpoint."""
        super().resizeEvent(event)
        self._apply_mode()

    @override
    def showEvent(self, event: QShowEvent) -> None:
        """Apply the layout and restore keyboard focus on first show."""
        super().showEvent(event)
        self._apply_mode()
        if self._mode is not ShellMode.NARROW:
            self._list.focus_selection()

    @override
    def closeEvent(self, event: QCloseEvent) -> None:
        """Persist the window geometry/state before the close completes."""
        geometry = self.saveGeometry()
        state = self.saveState()
        updated = self._settings.model_copy(
            update={
                "window_geometry": geometry.data(),
                "window_state": state.data(),
            }
        )
        self._save_settings(updated)
        super().closeEvent(event)

    def _build_menu(self) -> None:
        """Compose the native File/Help menus and bind the locked commands."""
        file_menu = self.menuBar().addMenu(self._texts.file_menu)
        self._new_download_action = QAction(self._texts.new_download, self)
        self._new_download_action.setShortcut(QKeySequence("Ctrl+N"))
        self._new_download_action.setShortcutContext(Qt.ShortcutContext.WindowShortcut)
        file_menu.addAction(self._new_download_action)
        self._new_clone_action = QAction(self._texts.new_clone, self)
        self._new_clone_action.setShortcut(QKeySequence("Ctrl+Shift+N"))
        self._new_clone_action.setShortcutContext(Qt.ShortcutContext.WindowShortcut)
        file_menu.addAction(self._new_clone_action)
        file_menu.addSeparator()
        self._refresh_action = QAction(self._texts.refresh_command, self)
        self._refresh_action.setShortcut(QKeySequence("F5"))
        file_menu.addAction(self._refresh_action)
        file_menu.addSeparator()
        self._settings_action = QAction(self._texts.settings_command, self)
        file_menu.addAction(self._settings_action)
        file_menu.addSeparator()
        quit_action = QAction(self._texts.quit_command, self)
        file_menu.addAction(quit_action)
        if self._model.has_help():
            help_menu = self.menuBar().addMenu(self._texts.help_menu)
            self._help_action = QAction(self._texts.help_command, self)
            help_menu.addAction(self._help_action)
        else:
            self._help_action = None
        self._new_download_action.triggered.connect(self._on_new_download)
        self._new_clone_action.triggered.connect(self._on_new_clone)
        self._refresh_action.triggered.connect(self._on_refresh)
        self._settings_action.triggered.connect(
            lambda: self._model.set_destination(Destination.SETTINGS)
        )
        quit_action.triggered.connect(self.close)
        if self._help_action is not None:
            self._help_action.triggered.connect(self._on_help)

    def _build_central(self) -> None:
        """Compose the fixed navigation rail and the four-destination stack."""
        self._tasks_page = QWidget(self)
        tasks_layout = QHBoxLayout(self._tasks_page)
        tasks_layout.setContentsMargins(0, 0, 0, 0)
        tasks_layout.setSpacing(0)
        tasks_layout.addWidget(self._list, stretch=1)
        tasks_layout.addWidget(self._detail, stretch=1)
        central = QWidget(self)
        shell = QHBoxLayout(central)
        shell.setContentsMargins(0, 0, 0, 0)
        shell.setSpacing(0)
        shell.addWidget(self._nav)
        self._content_stack = QStackedWidget(central)
        self._content_stack.addWidget(self._tasks_page)
        self._content_stack.addWidget(self._cache_view)
        self._content_stack.addWidget(self._diagnostics_view)
        self._content_stack.addWidget(self._settings_view)
        shell.addWidget(self._content_stack, stretch=1)
        self.setCentralWidget(central)
        self._apply_mode()

    def _connect(self) -> None:
        """Wire navigation, selection, back, runtime, and create-dialog signals."""
        self._model.destination_changed.connect(self._on_destination_changed)
        self._selection.task_selected.connect(self._on_task_selected)
        self._selection.back_requested.connect(self._on_back)
        self._detail.back_requested.connect(self._on_back)
        self._list.selection_changed.connect(self._selection.select)
        self._runtime.queue_changed.connect(self.refresh)
        self.create_download_requested.connect(self._open_download_dialog)
        self.create_clone_requested.connect(self._open_clone_dialog)

    def _on_destination_changed(self, value: str) -> None:
        """Route one destination to its real work surface in the content stack."""
        destination = Destination(value)
        match destination:
            case Destination.TASKS:
                self._content_stack.setCurrentWidget(self._tasks_page)
                self._selection.show_list()
                self._apply_mode()
                selected = self._selection.selected_task_id()
                if selected is not None:
                    self._refresh_detail(selected)
                self._list.focus_selection()
            case Destination.CACHE:
                self._content_stack.setCurrentWidget(self._cache_view)
                if self._cache_view.readout() is None:
                    self._cache_view.refresh()
                self._apply_mode()
                self._restore_view_focus(self._cache_view)
            case Destination.DIAGNOSTICS:
                self._content_stack.setCurrentWidget(self._diagnostics_view)
                self._apply_mode()
                self._restore_view_focus(self._diagnostics_view)
            case Destination.SETTINGS:
                self._content_stack.setCurrentWidget(self._settings_view)
                self._apply_mode()
                self._restore_view_focus(self._settings_view)

    def _restore_view_focus(self, view: QWidget) -> None:
        """Give keyboard focus to the first strong-focus control of one surface."""
        for candidate in view.findChildren(QWidget):
            if candidate.focusPolicy() not in (
                Qt.FocusPolicy.NoFocus,
                Qt.FocusPolicy.ClickFocus,
            ):
                candidate.setFocus(Qt.FocusReason.TabFocusReason)
                return

    def _on_task_selected(self, raw: str) -> None:
        """Show the selected task's detail and, in narrow mode, own the pane."""
        task_id = parse_task_id(raw)
        self._selection.show_detail()
        self._refresh_detail(task_id)
        self._apply_mode()
        if self._mode is ShellMode.NARROW:
            self._detail.restore_focus()

    def _on_back(self) -> None:
        """Return the narrow pane to the list and restore its focus."""
        self._selection.show_list()
        self._apply_mode()
        self._list.focus_selection()

    def _on_new_download(self) -> None:
        """Route the New Download command to the working creation dialog."""
        self.create_download_requested.emit()

    def _on_new_clone(self) -> None:
        """Route the New Clone command to the working creation dialog."""
        self.create_clone_requested.emit()

    def _on_refresh(self) -> None:
        """Announce and perform the Refresh command."""
        self.refresh_requested.emit()
        self.refresh()

    def _on_help(self) -> None:
        """Open the configured Help URL in the default browser, if any."""
        url = self._model.help_url()
        if url is None:
            return
        self.help_requested.emit()
        _ = QDesktopServices.openUrl(QUrl(url))

    def _open_download_dialog(self) -> None:
        """Launch the download dialog as a modal sheet over this window."""
        current = self._download_dialog
        if current is not None and not current.isHidden():
            current.raise_()
            return
        dialog = DownloadDialog(self._download_service, self._create_texts)
        self._wire_create_dialog(dialog, self._on_download_dialog_finished)
        self._download_dialog = dialog
        dialog.show()
        dialog.raise_()

    def _open_clone_dialog(self) -> None:
        """Launch the clone dialog as a modal sheet over this window."""
        current = self._clone_dialog
        if current is not None and not current.isHidden():
            current.raise_()
            return
        dialog = CloneDialog(self._clone_service, self._create_texts)
        self._wire_create_dialog(dialog, self._on_clone_dialog_finished)
        self._clone_dialog = dialog
        dialog.show()
        dialog.raise_()

    def _wire_create_dialog(
        self, dialog: QDialog, on_finished: Callable[[int], None]
    ) -> None:
        """Reparent, modalize, and auto-delete one transient creation dialog."""
        dialog.setParent(self)
        dialog.setModal(True)
        dialog.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        _ = dialog.finished.connect(on_finished)

    def _on_download_dialog_finished(self, _result: int) -> None:
        """Drop the shell's reference once the download dialog closes."""
        self._download_dialog = None

    def _on_clone_dialog_finished(self, _result: int) -> None:
        """Drop the shell's reference once the clone dialog closes."""
        self._clone_dialog = None

    def _refresh_detail(self, task_id: TaskId) -> None:
        """Render one immutable detail snapshot or clear when the task is gone."""
        try:
            detail = self._runtime.detail(task_id)
        except TaskNotFoundError:
            self._detail.clear()
            self._selection.select(None)
            return
        self._detail.show_snapshot(detail)

    def _apply_mode(self) -> None:
        """Reflow panes for the current effective width (DESIGN.md 8.2)."""
        mode = _mode_for_width(self.width())
        self._mode = mode
        showing_detail = self._selection.is_showing_detail()
        on_tasks = self.current_destination() is Destination.TASKS
        match mode:
            case ShellMode.NARROW:
                # Hidden panes must never drive the window's minimum size, or
                # the shell would auto-grow past the breakpoint (DESIGN 8.2).
                self._nav.hide()
                self._nav.setFixedWidth(0)
                self._detail.set_back_visible(on_tasks and showing_detail)
                self._list.setVisible(on_tasks and not showing_detail)
                self._detail.setVisible(on_tasks and showing_detail)
                self._list.setMinimumWidth(0)
                self._list.setMaximumWidth(_UNBOUNDED)
            case ShellMode.MEDIUM | ShellMode.WIDE:
                self._nav.show()
                self._nav.set_collapsed(mode is ShellMode.MEDIUM)
                self._list.show()
                self._detail.show()
                self._list.setFixedWidth(tokens.TASK_LIST_WIDTH)
                self._detail.set_back_visible(False)

    def _apply_degraded_banner(self) -> None:
        """Show the first non-fatal startup concern in the status bar."""
        if not self._degraded:
            return
        first = self._degraded[0]
        message = f"{self._texts.degraded_prefix}: {first.code} {first.detail}"
        self.statusBar().showMessage(message)

    def _restore_geometry(self) -> None:
        """Restore persisted geometry clamped to current screens, else default."""
        raw = self._settings.window_geometry
        if raw is not None and self.restoreGeometry(raw):
            available = tuple(
                screen.availableGeometry() for screen in QGuiApplication.screens()
            )
            self.setGeometry(clamp_frame_to_available(self.frameGeometry(), available))
            return
        self.resize(_DEFAULT_WINDOW_SIZE)
        self._center_on_primary()

    def _center_on_primary(self) -> None:
        """Center the window on the primary screen's available geometry."""
        screen = QGuiApplication.primaryScreen()
        geometry = screen.availableGeometry()
        self.move(geometry.center() - self.rect().center())
