"""Exact flat navigation model and pane for the responsive shell.

# noqa: SIZE_OK - one module must own the exact navigation contract: the
# closed destination enum, the bilingual shell vocabulary, the routing model,
# and the pane; splitting it would scatter one cohesive surface.

DESIGN.md Section 8.2 and the product brief fix the destination set to three
flat primary destinations (Tasks, Cache, Diagnostics) plus Settings in the
navigation footer (drafts:131). This module owns that closed model: the
:class:`Destination` enum, the bilingual :class:`ShellTexts` vocabulary used by
every shell surface, the :class:`NavigationModel` routing (which also gates the
optional Help URL, drafts:122), and the :class:`NavigationPane` that renders the
primary items above a footer separator so Settings never scrolls and the
navigation region carries no scroll owner (DESIGN.md 8.1).

The interim bilingual vocabulary lives here because the shell composes before
Todo 28 moves every UI literal into the Qt catalog; the two locales are exactly
the settings contract and the ``missing_ids`` gate stays untouched.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from typing import Final, final

from PySide6.QtCore import QObject, Signal
from PySide6.QtWidgets import QFrame, QVBoxLayout, QWidget

from hubfetch.config.settings import Locale
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.ui import icons, tokens
from hubfetch.ui.widgets.common import semantic_colors
from hubfetch.ui.widgets.navigation import NavigationItem
from hubfetch.ui.widgets.status import StatusSeverity

__all__ = [
    "FOOTER_DESTINATIONS",
    "PRIMARY_DESTINATIONS",
    "Destination",
    "NavigationModel",
    "NavigationPane",
    "ShellTexts",
]

_COLLAPSED_NAV_WIDTH: Final = 48
_EXPANDED_NAV_WIDTH: Final = 200
_ITEM_INSET: Final = tokens.SPACE_SM


@unique
class Destination(StrEnum):
    """Closed primary destinations; Settings lives in the navigation footer."""

    TASKS = "tasks"
    CACHE = "cache"
    DIAGNOSTICS = "diagnostics"
    SETTINGS = "settings"


PRIMARY_DESTINATIONS: Final[tuple[Destination, ...]] = (
    Destination.TASKS,
    Destination.CACHE,
    Destination.DIAGNOSTICS,
)
"""The three flat top-level destinations in locked order."""

FOOTER_DESTINATIONS: Final[tuple[Destination, ...]] = (Destination.SETTINGS,)
"""Destinations pinned below the navigation separator."""

_SEVERITY_BY_STATE: Final[dict[LifecycleState, StatusSeverity]] = {
    LifecycleState.QUEUED: StatusSeverity.QUEUED,
    LifecycleState.RUNNING: StatusSeverity.ACTIVE,
    LifecycleState.CANCELLING: StatusSeverity.ACTIVE,
    LifecycleState.SUCCEEDED: StatusSeverity.SUCCEEDED,
    LifecycleState.FAILED: StatusSeverity.FAILED,
    LifecycleState.CANCELLED: StatusSeverity.CANCELLED,
    LifecycleState.INTERRUPTED: StatusSeverity.INTERRUPTED,
}
"""Row status semantics of every lifecycle state (never color-only)."""


@dataclass(frozen=True, slots=True)
class ShellTexts:
    """Bilingual shell vocabulary resolved by locale.

    These strings are the interim shell vocabulary until Todo 28 migrates every
    UI literal into the Qt catalogs; both locales ship so captures and tests can
    prove the shell renders identically in Simplified Chinese and English.
    """

    window_title: str
    file_menu: str
    help_menu: str
    new_download: str
    new_clone: str
    quit_command: str
    refresh_command: str
    settings_command: str
    help_command: str
    nav_tasks: str
    nav_cache: str
    nav_diagnostics: str
    nav_settings: str
    pending_description: str
    tasks_header: str
    tasks_empty_title: str
    tasks_empty_description: str
    back_command: str
    detail_empty_title: str
    detail_empty_description: str
    queue_position_label: str
    state_label: str
    kind_label: str
    repository_label: str
    attempt_label: str
    created_label: str
    progress_label: str
    degraded_prefix: str
    kind_texts: dict[str, str]
    state_texts: dict[LifecycleState, str]
    queue_position_format: str

    @classmethod
    def for_locale(cls, locale: Locale) -> ShellTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return ShellTexts(
                window_title="HubFetch",
                file_menu="File",
                help_menu="Help",
                new_download="New Download",
                new_clone="New Clone",
                quit_command="Quit",
                refresh_command="Refresh",
                settings_command="Settings",
                help_command="Help",
                nav_tasks="Tasks",
                nav_cache="Cache",
                nav_diagnostics="Diagnostics",
                nav_settings="Settings",
                pending_description="This workspace is not available yet",
                tasks_header="Tasks",
                tasks_empty_title="No tasks",
                tasks_empty_description="Create tasks from the File menu",
                back_command="Back to task list",
                detail_empty_title="No task selected",
                detail_empty_description="Select a task in the list to see its details",
                queue_position_label="Queue position",
                state_label="State",
                kind_label="Kind",
                repository_label="Repository",
                attempt_label="Attempt",
                created_label="Created",
                progress_label="Progress",
                degraded_prefix="Startup degraded",
                kind_texts={
                    "single_file": "Single file",
                    "snapshot": "Snapshot",
                    "git_clone": "Clone",
                },
                state_texts={
                    LifecycleState.QUEUED: "Queued",
                    LifecycleState.RUNNING: "Transferring",
                    LifecycleState.CANCELLING: "Cancelling",
                    LifecycleState.SUCCEEDED: "Succeeded",
                    LifecycleState.FAILED: "Failed",
                    LifecycleState.CANCELLED: "Cancelled",
                    LifecycleState.INTERRUPTED: "Interrupted",
                },
                queue_position_format="Position {position}",
            )
        return ShellTexts(
            window_title="HubFetch",
            file_menu="文件",
            help_menu="帮助",
            new_download="新建下载",
            new_clone="新建克隆",
            quit_command="退出",
            refresh_command="刷新",
            settings_command="设置",
            help_command="帮助",
            nav_tasks="任务",
            nav_cache="缓存",
            nav_diagnostics="诊断",
            nav_settings="设置",
            pending_description="该工作区尚未提供",
            tasks_header="任务",
            tasks_empty_title="暂无任务",
            tasks_empty_description="使用文件菜单新建下载或克隆任务",
            back_command="返回任务列表",
            detail_empty_title="未选择任务",
            detail_empty_description="在任务列表中选择一项以查看详情",
            queue_position_label="队列位置",
            state_label="状态",
            kind_label="类型",
            repository_label="仓库",
            attempt_label="尝试",
            created_label="创建时间",
            progress_label="进度",
            degraded_prefix="启动降级",
            kind_texts={
                "single_file": "单文件",
                "snapshot": "快照",
                "git_clone": "克隆",
            },
            state_texts={
                LifecycleState.QUEUED: "排队中",
                LifecycleState.RUNNING: "传输中",
                LifecycleState.CANCELLING: "取消中",
                LifecycleState.SUCCEEDED: "已完成",
                LifecycleState.FAILED: "失败",
                LifecycleState.CANCELLED: "已取消",
                LifecycleState.INTERRUPTED: "已中断",
            },
            queue_position_format="第 {position} 位",
        )

    def nav_label(self, destination: Destination) -> str:
        """Return the visible navigation label of one destination."""
        match destination:
            case Destination.TASKS:
                return self.nav_tasks
            case Destination.CACHE:
                return self.nav_cache
            case Destination.DIAGNOSTICS:
                return self.nav_diagnostics
            case Destination.SETTINGS:
                return self.nav_settings

    def kind_text(self, kind: str) -> str:
        """Return the display label of one task-spec kind tag."""
        return self.kind_texts.get(kind, kind)

    def state_text(self, state: LifecycleState) -> str:
        """Return the display label of one lifecycle state."""
        return self.state_texts[state]

    def state_severity(self, state: LifecycleState) -> StatusSeverity:
        """Return the row status semantics of one lifecycle state."""
        return _SEVERITY_BY_STATE[state]

    def queue_caption(self, position: int) -> str:
        """Render the queue-position caption for one snapshot row."""
        return self.queue_position_format.format(position=position)


@final
class NavigationModel(QObject):
    """Current-destination routing plus the optional Help URL gate.

    ``destination_changed`` carries the ``Destination.value`` so Qt signals
    stay typed enough for consumers without leaking enum objects.
    """

    destination_changed = Signal(str)
    """Emitted with the new destination value whenever routing moves."""

    __slots__: Final = ("_current", "_help_url", "_texts")
    _texts: ShellTexts
    _current: Destination
    _help_url: str | None

    def __init__(self, texts: ShellTexts, help_url: str | None = None) -> None:
        """Open on Tasks; Help is present only when a URL was configured."""
        super().__init__()
        self._texts = texts
        self._current = Destination.TASKS
        self._help_url = help_url

    @property
    def texts(self) -> ShellTexts:
        """Return the shell vocabulary bound to this model."""
        return self._texts

    def primary_destinations(self) -> tuple[Destination, ...]:
        """Return the locked flat primary destination set."""
        return PRIMARY_DESTINATIONS

    def footer_destinations(self) -> tuple[Destination, ...]:
        """Return the destinations pinned to the navigation footer."""
        return FOOTER_DESTINATIONS

    def current_destination(self) -> Destination:
        """Return the destination the shell currently shows."""
        return self._current

    def set_destination(self, destination: Destination) -> None:
        """Route to a destination and announce the change exactly once."""
        if destination is self._current:
            return
        self._current = destination
        self.destination_changed.emit(destination.value)

    def help_url(self) -> str | None:
        """Return the configured Help URL, or ``None`` when unset."""
        return self._help_url

    def has_help(self) -> bool:
        """Return whether the Help command may exist at all."""
        return self._help_url is not None


class NavigationPane(QWidget):
    """Flat primary items over a footer separator; never scrolls.

    Expanded (wide) mode shows icon plus label at a fixed width; collapsed
    (medium) mode hides the labels so only the icon rail remains, with each
    label preserved as a tooltip for accessibility and wayfinding.
    """

    __slots__: Final = (
        "_collapsed",
        "_items",
        "_model",
        "_primary_items",
        "_settings_item",
    )
    _model: NavigationModel
    _primary_items: list[NavigationItem]
    _settings_item: NavigationItem
    _items: tuple[NavigationItem, ...]
    _collapsed: bool

    def __init__(self, model: NavigationModel) -> None:
        """Build the flat item list and bind clicks to the routing model."""
        super().__init__()
        self._model = model
        texts = model.texts
        layout = QVBoxLayout(self)
        layout.setContentsMargins(
            tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM, tokens.SPACE_SM
        )
        layout.setSpacing(tokens.SPACE_XS)
        self._primary_items = [
            self._build_item(icon, texts.nav_label(destination))
            for icon, destination in (
                (icons.IconName.LIST_TODO, Destination.TASKS),
                (icons.IconName.DATABASE, Destination.CACHE),
                (icons.IconName.SQUARE_TERMINAL, Destination.DIAGNOSTICS),
            )
        ]
        for item in self._primary_items:
            layout.addWidget(item)
        layout.addStretch(1)
        separator = QFrame(self)
        separator.setFrameShape(QFrame.Shape.HLine)
        colors = semantic_colors(self.palette())
        separator.setStyleSheet(f"color: {colors.border};")
        layout.addWidget(separator)
        self._settings_item = self._build_item(
            icons.IconName.SETTINGS, texts.nav_label(Destination.SETTINGS)
        )
        layout.addWidget(self._settings_item)
        self._items = (*self._primary_items, self._settings_item)
        self._collapsed = False
        self._sync_selection()
        _ = model.destination_changed.connect(self._sync_selection)
        self.setAccessibleName("导航")

    def primary_items(self) -> tuple[NavigationItem, ...]:
        """Return the flat primary destination items in order."""
        return tuple(self._primary_items)

    def footer_items(self) -> tuple[NavigationItem, ...]:
        """Return the footer destination items (Settings)."""
        return (self._settings_item,)

    def is_collapsed(self) -> bool:
        """Return whether the pane currently renders as an icon rail."""
        return self._collapsed

    def set_collapsed(self, collapsed: bool) -> None:
        """Toggle between full labels and the icon-only rail."""
        self._collapsed = collapsed
        for item in self._items:
            item.setText("" if collapsed else item.accessibleName())
        for item in self._items:
            item.setToolTip(item.accessibleName() if collapsed else "")
        width = _COLLAPSED_NAV_WIDTH if collapsed else _EXPANDED_NAV_WIDTH
        self.setFixedWidth(width)
        for item in self._items:
            item.setFixedWidth(width - _ITEM_INSET * 2)

    def _build_item(self, icon_name: icons.IconName, label: str) -> NavigationItem:
        item = NavigationItem(icon_name, label)
        item.setFixedWidth(_EXPANDED_NAV_WIDTH - _ITEM_INSET * 2)
        item.clicked.connect(self._on_item_clicked)
        return item

    def _on_item_clicked(self) -> None:
        """Route a clicked item to its destination through the model."""
        sender_item = self.sender()
        if not isinstance(sender_item, NavigationItem):
            return
        for item, destination in self._mapped_items():
            if item is sender_item:
                self._model.set_destination(destination)
                return

    def _mapped_items(self) -> tuple[tuple[NavigationItem, Destination], ...]:
        pairs: list[tuple[NavigationItem, Destination]] = [
            (item, destination)
            for item, destination in zip(
                self._primary_items, PRIMARY_DESTINATIONS, strict=True
            )
        ]
        pairs.append((self._settings_item, Destination.SETTINGS))
        return tuple(pairs)

    def _sync_selection(self) -> None:
        """Highlight the item matching the current routed destination."""
        current = self._model.current_destination()
        for item, destination in self._mapped_items():
            item.set_selected(destination is current)
