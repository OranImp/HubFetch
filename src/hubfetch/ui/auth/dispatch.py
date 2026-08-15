"""Off-thread work dispatchers for the auth panel.

Browser authorization polls run blocking Hub calls, so the panel never awaits
them on the GUI thread. :class:`ThreadPoolWorkDispatcher` runs one unit of work
on Qt's shared thread pool and delivers the typed outcome back on the GUI
thread; :class:`SynchronousWorkDispatcher` executes inline for deterministic
tests and captures; :class:`CapturingWorkDispatcher` records submitted work so
tests drive the pending state one step at a time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol, final, override

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal

if TYPE_CHECKING:
    from collections.abc import Callable

_BOUNDARY_ERRORS: Final = (OSError, RuntimeError, ValueError)
"""Typed exception families that can escape a browser-await boundary."""


class WorkDispatcher(Protocol):
    """Run one unit of auth work off the GUI thread and deliver its outcome."""

    def submit(
        self,
        work: Callable[[], object],
        on_result: Callable[[object], None],
        on_error: Callable[[BaseException], None],
    ) -> None:
        """Queue ``work``; invoke the matching callback on the GUI thread."""
        ...


@dataclass(frozen=True, slots=True)
class _WorkOutcome:
    """The captured result or boundary error of one off-thread unit of work."""

    result: object
    error: BaseException | None


@final
class _OutcomeEmitter(QObject):
    """GUI-thread object whose queued signal carries one work outcome."""

    emitted: Signal = Signal(object)

    __slots__: Final = ("_keep", "_on_error", "_on_result")

    _on_result: Callable[[object], None]
    _on_error: Callable[[BaseException], None]
    _keep: _OutcomeEmitter | None

    def __init__(
        self,
        on_result: Callable[[object], None],
        on_error: Callable[[BaseException], None],
    ) -> None:
        """Route one outcome to its result or error callback."""
        super().__init__()
        self._on_result = on_result
        self._on_error = on_error
        self._keep = self
        self.emitted.connect(self._handle)

    def _handle(self, outcome: object) -> None:
        """Dispatch one captured outcome to the matching callback."""
        self._keep = None
        if not isinstance(outcome, _WorkOutcome):
            return
        if outcome.error is not None:
            self._on_error(outcome.error)
            return
        if outcome.result is not None:
            self._on_result(outcome.result)


@final
class _PlanRunnable(QRunnable):
    """Run one work callable and emit its captured outcome when done."""

    __slots__: Final = ("_emitter", "_work")

    _work: Callable[[], object]
    _emitter: _OutcomeEmitter

    def __init__(self, work: Callable[[], object], emitter: _OutcomeEmitter) -> None:
        """Bind the work callable to the outcome emitter."""
        super().__init__()
        self._work = work
        self._emitter = emitter

    @override
    def run(self) -> None:
        """Execute the work and emit the captured outcome to the GUI thread."""
        try:
            result: object = self._work()
        except _BOUNDARY_ERRORS as error:
            self._emitter.emitted.emit(_WorkOutcome(result=None, error=error))
        else:
            self._emitter.emitted.emit(_WorkOutcome(result=result, error=None))


class ThreadPoolWorkDispatcher:
    """Deliver work outcomes through Qt's shared thread pool and queued signal."""

    __slots__: Final = ("_pool",)

    _pool: QThreadPool

    def __init__(self, pool: QThreadPool | None = None) -> None:
        """Bind the shared pool (or an injected pool for deterministic tests)."""
        self._pool = pool if pool is not None else QThreadPool.globalInstance()

    def submit(
        self,
        work: Callable[[], object],
        on_result: Callable[[object], None],
        on_error: Callable[[BaseException], None],
    ) -> None:
        """Queue ``work`` and route its outcome back to the GUI thread."""
        emitter = _OutcomeEmitter(on_result, on_error)
        self._pool.start(_PlanRunnable(work, emitter))


class SynchronousWorkDispatcher:
    """Run work inline for single-threaded, deterministic test flows."""

    def submit(
        self,
        work: Callable[[], object],
        on_result: Callable[[object], None],
        on_error: Callable[[BaseException], None],
    ) -> None:
        """Execute ``work`` immediately and invoke the matching callback."""
        try:
            result: object = work()
        except _BOUNDARY_ERRORS as error:
            on_error(error)
        else:
            on_result(result)


@final
class CapturingWorkDispatcher:
    """Record submitted work so tests drive pending state step by step."""

    __slots__: Final = ("pending",)

    pending: list[
        tuple[
            Callable[[], object],
            Callable[[object], None],
            Callable[[BaseException], None],
        ]
    ]

    def __init__(self) -> None:
        """Open an empty pending work queue."""
        self.pending = []

    def submit(
        self,
        work: Callable[[], object],
        on_result: Callable[[object], None],
        on_error: Callable[[BaseException], None],
    ) -> None:
        """Queue one work unit without executing it."""
        self.pending.append((work, on_result, on_error))

    def run_one(self) -> None:
        """Execute the oldest queued work unit and deliver its outcome."""
        work, on_result, on_error = self.pending.pop(0)
        try:
            result: object = work()
        except _BOUNDARY_ERRORS as error:
            on_error(error)
        else:
            on_result(result)


__all__ = [
    "CapturingWorkDispatcher",
    "SynchronousWorkDispatcher",
    "ThreadPoolWorkDispatcher",
    "WorkDispatcher",
]
