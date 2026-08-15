"""Runtime-backed service adapters for the two creation flows.

The dialogs depend only on the :class:`DownloadCreateService` and
:class:`CloneCreateService` protocols; these adapters implement them over the
Todo 17 planner, the Todo 12 dependency checker, the Todo 19 destination rule,
and the application runtime's typed create command. They never touch the GUI
thread directly — the dialog runs their methods through the off-thread
dispatcher. The composition root may substitute deterministic fakes of the
same protocols for tests and captures.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from hubfetch.diagnostics.git import DependencyState, GitDependencyChecker
from hubfetch.domain.task_spec import (
    LocalDirectoryDestination,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.hub.adapter import HubAdapter
from hubfetch.hub.planner import DownloadPlanner

from .contracts import ClonePreflight
from .validation import check_clone_destination

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from hubfetch.application.runtime import Runtime
    from hubfetch.config.settings import Settings
    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import TaskSpec
    from hubfetch.hub.contracts import HubAdapterProtocol
    from hubfetch.hub.planner import DownloadPlan
    from hubfetch.persistence.records import TaskRecord


class RuntimeDownloadService:
    """Plan downloads through the Todo 17 planner and enqueue through the runtime.

    The adapter is built per plan so auth and proxy validation happen before
    any request, exactly as the pinned adapter contract requires; an injected
    ``adapter_factory`` lets the composition root point planning at a
    deterministic fixture adapter.
    """

    __slots__: Final = ("_adapter_factory", "_runtime", "_settings")

    _runtime: Runtime
    _settings: Settings
    _adapter_factory: (
        Callable[[SingleFileDownloadSpec | SnapshotDownloadSpec], HubAdapterProtocol]
        | None
    )

    def __init__(
        self,
        runtime: Runtime,
        settings: Settings,
        *,
        adapter_factory: Callable[
            [SingleFileDownloadSpec | SnapshotDownloadSpec], HubAdapterProtocol
        ]
        | None = None,
    ) -> None:
        """Bind the runtime, settings, and an optional fixture adapter factory."""
        self._runtime = runtime
        self._settings = settings
        self._adapter_factory = adapter_factory

    def plan(self, spec: SingleFileDownloadSpec | SnapshotDownloadSpec) -> DownloadPlan:
        """Run Todo 17 planning for one download specification."""
        adapter = (
            self._adapter_factory(spec)
            if self._adapter_factory is not None
            else self._build_adapter(spec)
        )
        return DownloadPlanner(adapter).plan(spec)

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Persist one confirmed task through the application runtime."""
        return self._runtime.create_task(task_id, spec, attempt_id)

    def _build_adapter(
        self, spec: SingleFileDownloadSpec | SnapshotDownloadSpec
    ) -> HubAdapter:
        """Construct the pinned adapter from the spec's auth and destination."""
        local_dir = (
            spec.destination.path
            if isinstance(spec.destination, LocalDirectoryDestination)
            else None
        )
        return HubAdapter(
            auth_source=spec.auth_source,
            proxy_mode=spec.proxy_mode,
            manual_proxy_url=self._settings.manual_proxy_url,
            local_dir=local_dir,
        )


class RuntimeCloneService:
    """Preflight clones through Todo 12/19 and enqueue through the runtime."""

    __slots__: Final = ("_checker", "_runtime")

    _runtime: Runtime
    _checker: GitDependencyChecker

    def __init__(
        self, runtime: Runtime, *, checker: GitDependencyChecker | None = None
    ) -> None:
        """Bind the runtime and the read-only Git dependency checker."""
        self._runtime = runtime
        self._checker = checker if checker is not None else GitDependencyChecker()

    def preflight(self, destination: Path) -> ClonePreflight:
        """Combine the Todo 12 dependency report with the Todo 19 verdict."""
        report = self._checker.check()
        destination_check = check_clone_destination(destination)
        guidance: list[str] = [*report.guidance]
        if not destination_check.ready:
            guidance.append(f"destination {destination_check.detail}")
        ready = report.state is DependencyState.READY and destination_check.ready
        return ClonePreflight(
            git=report,
            destination=destination_check,
            ready=ready,
            guidance=tuple(guidance),
        )

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Persist one confirmed task through the application runtime."""
        return self._runtime.create_task(task_id, spec, attempt_id)


__all__ = ["RuntimeCloneService", "RuntimeDownloadService"]
