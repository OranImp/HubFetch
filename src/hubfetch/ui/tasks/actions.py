"""Pure action-model logic for task Cancel/Retry/Open Folder/Copy Diagnostic.

The action model is deliberately UI-free: it computes which commands are
valid for the current task state, and routes invocations through an injected
:class:`TaskCommands` seam of callables. A ``None`` seam disables the matching
action. ``cancelling`` stays visibly active until a terminal snapshot arrives
(no second cancel is ever offered), and Git retry refuses to fire against a
non-empty destination — it signals :attr:`destination_required` instead so the
detail view can drive explicit new-destination recovery.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from PySide6.QtCore import QObject, Signal

from hubfetch.domain.lifecycle import TERMINAL_STATES, LifecycleState
from hubfetch.domain.task_spec import GitCloneSpec, LocalDirectoryDestination
from hubfetch.security.redaction import Redactor, SecretRegistry

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from hubfetch.application.snapshots import DetailSnapshot, TaskSnapshot
    from hubfetch.domain.ids import TaskId
    from hubfetch.domain.task_spec import TaskSpec

RETRYABLE_STATES: Final[frozenset[LifecycleState]] = frozenset(
    {
        LifecycleState.FAILED,
        LifecycleState.CANCELLED,
        LifecycleState.INTERRUPTED,
    }
)
CANCELLABLE_STATES: Final[frozenset[LifecycleState]] = frozenset(
    {LifecycleState.QUEUED, LifecycleState.RUNNING}
)


@dataclass(frozen=True, slots=True)
class TaskCommands:
    """The injected command seam; every callable may be absent."""

    cancel: Callable[[TaskId], None] | None = None
    retry: Callable[[TaskId], None] | None = None
    open_folder: Callable[[Path], None] | None = None


def _git_destination_available(spec: TaskSpec) -> bool:
    """Return whether a Git retry target is already a new/empty directory."""
    if not isinstance(spec, GitCloneSpec):
        return True
    destination = spec.destination
    if not destination.exists():
        return True
    if not destination.is_dir():
        return False
    return not any(destination.iterdir())


class TaskActionModel(QObject):
    """Computes the valid action set and routes commands through the seam."""

    actions_changed: Signal = Signal()
    destination_required: Signal = Signal(str)

    _commands: TaskCommands
    _task: TaskSnapshot | None
    _detail: DetailSnapshot | None
    _cancel_attempted: bool
    _redactor: Redactor

    def __init__(
        self,
        commands: TaskCommands | None = None,
        registry: SecretRegistry | None = None,
    ) -> None:
        """Bind the optional command seam and start with no task."""
        super().__init__()
        self._commands = commands or TaskCommands()
        self._task = None
        self._detail = None
        self._cancel_attempted = False
        self._redactor = Redactor(registry)

    # -- snapshot state -----------------------------------------------------

    def _update(self, detail: DetailSnapshot) -> None:
        """Recompute the available actions from one fresh detail snapshot."""
        self._detail = detail
        self._task = detail.task
        if detail.task.state in TERMINAL_STATES:
            # A terminal snapshot closes any in-flight cancel.
            self._cancel_attempted = False
        self.actions_changed.emit()

    def apply_detail(self, detail: DetailSnapshot) -> None:
        """Adopt a new detail snapshot and refresh the action set."""
        self._update(detail)

    # -- computed validity (truthful, state-driven) -------------------------

    def can_cancel(self) -> bool:
        """Cancel is valid only for queued/running tasks with a seam."""
        if self._task is None or self._commands.cancel is None:
            return False
        return self._task.state in CANCELLABLE_STATES

    def cancelling_active(self) -> bool:
        """The cancel is in flight until the snapshot terminalizes."""
        if self._task is None:
            return False
        if self._task.state is LifecycleState.CANCELLING:
            return True
        return self._cancel_attempted and self._task.state in CANCELLABLE_STATES

    def can_retry(self) -> bool:
        """Retry is valid only for retryable states with a seam."""
        if self._task is None or self._commands.retry is None:
            return False
        return self._task.state in RETRYABLE_STATES

    def can_open_folder(self) -> bool:
        """Open Folder is valid only for an existing safe local directory."""
        if self._task is None or self._commands.open_folder is None:
            return False
        return self._local_folder() is not None

    def can_copy_diagnostic(self) -> bool:
        """Copy Diagnostic is always available for a loaded task."""
        return self._task is not None

    def retry_needs_destination(self) -> bool:
        """A Git retry whose target is non-empty needs a new destination."""
        if self._task is None or not self.can_retry():
            return False
        return not _git_destination_available(self._task.spec)

    # -- command routing (through the seam, never direct) -------------------

    def request_cancel(self) -> None:
        """Fire Cancel once; a cancelling task never gets a second command."""
        if self._task is None or self._commands.cancel is None:
            return
        if self._cancel_attempted:
            return  # one-shot: stays visibly cancelling until terminal
        if not self.can_cancel():
            return
        self._cancel_attempted = True
        self._commands.cancel(self._task.task_id)
        self.actions_changed.emit()

    def request_retry(self) -> None:
        """Fire Retry, or demand a new destination for a blocked Git target."""
        if self._task is None or self._commands.retry is None:
            return
        if not self.can_retry():
            return
        if self.retry_needs_destination():
            self.destination_required.emit(self._task.task_id)
            return
        self._commands.retry(self._task.task_id)

    def request_open_folder(self) -> None:
        """Fire Open Folder only when a safe local directory exists."""
        if self._task is None or self._commands.open_folder is None:
            return
        if not self.can_open_folder():
            return
        folder = self._local_folder()
        if folder is not None:
            self._commands.open_folder(folder)

    def request_copy_diagnostic(self) -> str:
        """Return the sanitized one-line diagnostic summary for the clipboard."""
        task = self._task
        if task is None:
            return ""
        summary = (
            f"task={task.task_id} attempt={task.attempt_id} "
            f"state={task.state.value} position={task.position} "
            f"repo={task.spec.repository.repo_id} kind={task.spec.kind}"
        )
        return self._redactor.redact_text(summary)

    # -- helpers ------------------------------------------------------------

    def _local_folder(self) -> Path | None:
        """Return the existing local directory to open, if any."""
        task = self._task
        if task is None:
            return None
        spec = task.spec
        if isinstance(spec, GitCloneSpec):
            candidate = spec.destination
        else:
            destination = spec.destination
            if not isinstance(destination, LocalDirectoryDestination):
                return None
            candidate = destination.path
        if candidate.exists() and candidate.is_dir():
            return candidate
        return None


__all__ = [
    "CANCELLABLE_STATES",
    "RETRYABLE_STATES",
    "TaskActionModel",
    "TaskCommands",
]
