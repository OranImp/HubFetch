"""Selection, narrow-mode back, and keyboard focus restoration for the shell.

The shell separates the list-pane selection state (which task is current) from
the narrow-mode visibility state (list or detail) so the back command and focus
restoration stay deterministic across snapshot rebuilds (DESIGN.md 8.2). Below
760 effective px only one pane is visible and the detail pane exposes an
explicit back icon command; at 760 px and wider both panes stay visible and no
back command exists.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import QObject, Qt, Signal

from hubfetch.ui import icons
from hubfetch.ui.widgets.buttons import IconButton

if TYPE_CHECKING:
    from PySide6.QtWidgets import QWidget

    from hubfetch.domain.ids import TaskId
    from hubfetch.ui.navigation import ShellTexts

__all__ = ["TaskSelection", "make_back_button", "restore_focus"]


def make_back_button(texts: ShellTexts) -> IconButton:
    """Build the explicit narrow-mode back icon command with an accessible name."""
    return IconButton(
        icons.IconName.ARROW_LEFT,
        accessible_name=texts.back_command,
        tooltip=texts.back_command,
    )


def restore_focus(target: QWidget | None, fallback: QWidget | None) -> None:
    """Give keyboard focus to ``target`` or, when absent, to ``fallback``."""
    widget = target if target is not None else fallback
    if widget is not None:
        widget.setFocus(Qt.FocusReason.TabFocusReason)


@final
class TaskSelection(QObject):
    """Which task is selected and whether narrow mode shows list or detail."""

    task_selected = Signal(str)
    """Emitted with the task id whenever a new task becomes the selection."""

    back_requested = Signal()
    """Emitted when the narrow-mode back command returns to the list."""

    __slots__: Final = ("_narrow_detail", "_selected")
    _selected: TaskId | None
    _narrow_detail: bool

    def __init__(self, parent: QObject | None = None) -> None:
        """Start with no selection, showing the list pane."""
        super().__init__(parent)
        self._selected = None
        self._narrow_detail = False

    def selected_task_id(self) -> TaskId | None:
        """Return the currently selected task id, if any."""
        return self._selected

    def select(self, task_id: TaskId | None) -> None:
        """Select one task and announce only real changes."""
        if task_id is not None and task_id == self._selected:
            return
        self._selected = task_id
        if task_id is not None:
            self.task_selected.emit(task_id)

    def is_showing_detail(self) -> bool:
        """Return whether narrow mode currently shows the detail pane."""
        return self._narrow_detail

    def show_detail(self) -> None:
        """Switch the narrow pane to detail; no-op at medium and wide widths."""
        self._narrow_detail = True

    def show_list(self) -> None:
        """Switch the narrow pane back to the task list."""
        self._narrow_detail = False

    def back(self) -> None:
        """Run the back command: show the list and announce the transition."""
        self.show_list()
        self.back_requested.emit()
