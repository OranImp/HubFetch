"""Bounded teardown of the runtime's process trees and store.

Closing the GUI or the runtime stops dispatch, marks every active supervisor
as shutting down, terminates each active Job (killing the whole worker tree,
never just the root), waits for every Job to report zero active processes, and
only then closes the SQLite connection. The emptiness observation is bounded
and QTimer-driven; the GUI thread is never blocked. Any ``running`` or
``cancelling`` row left behind is intentionally uncommitted here: the next
startup's ``recover_interrupted`` converts it to ``interrupted``. Commits that
happen during close bypass ``Scheduler.complete`` so no next task is ever
dispatched while the runtime is closing.
"""

from __future__ import annotations

import time
from contextlib import suppress
from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import QObject, QTimer, Signal

from hubfetch.platform.windows.job_object import JobObjectError

if TYPE_CHECKING:
    import sqlite3

    from hubfetch.runtime.scheduler import Scheduler
    from hubfetch.runtime.supervisor import Supervisor

_POLL_INTERVAL_MS: Final = 25


@final
class RuntimeShutdown(QObject):
    """Own one bounded close of the runtime's process trees and store."""

    finished = Signal()
    """Emitted once every Job is empty and the store is closed."""

    failed = Signal(str)
    """Emitted with a reason when the empty-Job bound was exceeded."""

    __slots__: Final = (
        "_confirm_timeout_ms",
        "_connection",
        "_deadline",
        "_finished",
        "_poll_timer",
        "_scheduler",
        "_supervisors",
    )
    _scheduler: Scheduler
    _supervisors: tuple[Supervisor, ...]
    _connection: sqlite3.Connection
    _poll_timer: QTimer
    _deadline: float
    _confirm_timeout_ms: int
    _finished: bool

    def __init__(
        self,
        *,
        scheduler: Scheduler,
        supervisors: tuple[Supervisor, ...],
        connection: sqlite3.Connection,
        confirm_timeout_ms: int,
        poll_interval_ms: int = _POLL_INTERVAL_MS,
    ) -> None:
        """Bind the close to the scheduler, active supervisors, and store."""
        super().__init__()
        self._scheduler = scheduler
        self._supervisors = supervisors
        self._connection = connection
        self._confirm_timeout_ms = confirm_timeout_ms
        self._finished = False
        self._deadline = 0.0
        self._poll_timer = QTimer(self)
        self._poll_timer.setInterval(poll_interval_ms)
        _ = self._poll_timer.timeout.connect(self._poll)

    @property
    def finished_cleanly(self) -> bool:
        """Return whether the store was closed after every Job emptied."""
        return self._finished

    def begin(self) -> None:
        """Stop dispatch, terminate every active Job, then observe emptiness."""
        self._scheduler.close()
        for supervisor in self._supervisors:
            supervisor.begin_shutdown()
            if supervisor.worker.is_running:
                supervisor.worker.terminate()
            with suppress(JobObjectError):
                supervisor.job.terminate()
        self._deadline = time.monotonic() + self._confirm_timeout_ms / 1000.0
        self._poll_timer.start()
        self._poll()

    def _poll(self) -> None:
        """Wait for every Job to empty and terminalize, then close the store."""
        if self._finished:
            self._poll_timer.stop()
            return
        if self._all_supervised_terminal():
            self._poll_timer.stop()
            self._close_every_job()
            self._connection.close()
            self._finished = True
            self.finished.emit()
        elif time.monotonic() >= self._deadline:
            self._poll_timer.stop()
            self._close_every_job()
            self.failed.emit("job_emptiness_timeout")

    def _all_supervised_terminal(self) -> bool:
        """Return whether every supervisor's Job emptied and attempt settled.

        A supervisor is settled when its Job holds no active processes and its
        attempt reached a terminal transition (or its worker never launched,
        in which case there is nothing left to settle).
        """
        for supervisor in self._supervisors:
            if supervisor.worker.is_running:
                return False
            if not supervisor.terminalized:
                return False
            try:
                if supervisor.job.active_process_ids():
                    return False
            except JobObjectError:
                continue  # a closed Job holds no processes
        return True

    def _close_every_job(self) -> None:
        """Release every Job handle so kill-on-close fires once for each."""
        for supervisor in self._supervisors:
            with suppress(JobObjectError):
                supervisor.job.close()


__all__: Final = ("RuntimeShutdown",)
