"""Shared typed fakes for the creation-dialog tests.

The dialogs depend only on the service protocols, the identifier factory, and
the work dispatcher; these deterministic doubles prove field dependencies,
planning state, estimates, validation, enqueue payloads, and secret absence
without any network, subprocess, or real planner. A manual dispatcher captures
off-thread work so the async planning state can be driven one step at a time.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, Literal

from hubfetch.diagnostics.disk import SpaceAssessment
from hubfetch.diagnostics.git import (
    DependencyState,
    GitDependencyReport,
    ToolProbeState,
    XetProbe,
    XetState,
)
from hubfetch.domain.errors import HubFetchError
from hubfetch.domain.ids import parse_attempt_id, parse_repository_id, parse_task_id
from hubfetch.domain.lifecycle import LifecycleState
from hubfetch.domain.repository import ModelRepository, RepositoryRef
from hubfetch.hub.contracts import PlannedFile
from hubfetch.hub.planner import DownloadPlan
from hubfetch.persistence.records import TaskRecord
from hubfetch.ui.create.contracts import CloneDestinationCheck, ClonePreflight

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import (
        SingleFileDownloadSpec,
        SnapshotDownloadSpec,
        TaskSpec,
    )

DEFAULT_COMMIT: Final = "9f8e7d6c5b4a3928a1b2c3d4e5f60718293a4b5c6"
SENTINEL: Final = "hf_test_secret_123"


def make_repository(revision: str | None = None) -> RepositoryRef:
    """Build one strict model repository reference for plan fixtures."""
    return RepositoryRef(
        repo_id=parse_repository_id("org/repo"),
        kind=ModelRepository(),
        revision=revision,
    )


def make_plan(
    *,
    destination: Path,
    kind: Literal["file", "snapshot"] = "snapshot",
    total_bytes: int | None = 100,
    files: int = 2,
    sufficient: bool | None = True,
) -> DownloadPlan:
    """Build one deterministic download plan for dialog tests."""
    planned = tuple(
        PlannedFile(
            path=f"weights/model-{index}.bin",
            size_bytes=None if total_bytes is None else total_bytes // files,
            cached=False,
            will_download=True,
        )
        for index in range(files)
    )
    return DownloadPlan(
        repository=make_repository(),
        kind=kind,
        resolved_commit=DEFAULT_COMMIT,
        destination=destination,
        selected_files=planned,
        total_bytes=total_bytes,
        cache_hits=0,
        cache_misses=files,
        space=SpaceAssessment(
            volume="C:\\",
            required_bytes=total_bytes,
            free_bytes=1_000_000 if sufficient is not False else 4,
            sufficient=sufficient,
            shortfall_bytes=None if sufficient is not False else (total_bytes or 0) - 4,
        ),
    )


def make_preflight(
    *,
    ready: bool | None = None,
    destination_ready: bool = True,
    git_state: DependencyState = DependencyState.READY,
    xet_state: XetState = XetState.CONFIGURED,
) -> ClonePreflight:
    """Build one deterministic clone preflight report for dialog tests."""
    destination = CloneDestinationCheck(
        ready=destination_ready,
        detail="destination.empty" if destination_ready else "destination.not_empty",
        category="empty" if destination_ready else "not_empty",
    )
    report = GitDependencyReport(
        git_state=ToolProbeState.INSTALLED,
        git_version="2.45.1" if git_state is DependencyState.READY else None,
        xet=XetProbe(
            state=xet_state,
            version="0.1.0" if xet_state is XetState.CONFIGURED else None,
            filters=(),
            detail="",
        ),
        state=git_state,
        guidance=()
        if git_state is DependencyState.READY
        else ("winget install --id git-xet.git-xet -e",),
    )
    if ready is None:
        ready = git_state is DependencyState.READY and destination_ready
    return ClonePreflight(
        git=report,
        destination=destination,
        ready=ready,
        guidance=report.guidance,
    )


class FakeDownloadService:
    """Deterministic DownloadCreateService recording every plan and create."""

    _plan: DownloadPlan | None
    _plan_error: HubFetchError | None

    def __init__(
        self,
        *,
        plan: DownloadPlan | None = None,
        plan_error: HubFetchError | None = None,
    ) -> None:
        """Bind the canned plan or error returned for every planning call."""
        self._plan = plan
        self._plan_error = plan_error
        self.planned_specs: list[SingleFileDownloadSpec | SnapshotDownloadSpec] = []
        self.created: list[tuple[TaskId, TaskSpec, AttemptId]] = []

    def plan(self, spec: SingleFileDownloadSpec | SnapshotDownloadSpec) -> DownloadPlan:
        """Record the spec and return the canned plan or raise the canned error."""
        self.planned_specs.append(spec)
        if self._plan_error is not None:
            raise self._plan_error
        if self._plan is None:
            message = "fake download service needs a plan or error"
            raise AssertionError(message)
        return self._plan

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Record the enqueue payload and return a minimal queued record."""
        self.created.append((task_id, spec, attempt_id))
        return TaskRecord(
            task_id=task_id,
            spec=spec,
            state=LifecycleState.QUEUED,
            attempt_id=attempt_id,
            position=1,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )


class FakeCloneService:
    """Deterministic CloneCreateService recording every preflight and create."""

    _preflight: ClonePreflight | None

    def __init__(self, *, preflight: ClonePreflight | None = None) -> None:
        """Bind the canned preflight report returned for every preflight call."""
        self._preflight = preflight
        self.preflighted_destinations: list[Path] = []
        self.created: list[tuple[TaskId, TaskSpec, AttemptId]] = []

    def preflight(self, destination: Path) -> ClonePreflight:
        """Record the destination and return the canned preflight report."""
        self.preflighted_destinations.append(destination)
        if self._preflight is None:
            message = "fake clone service needs a preflight report"
            raise AssertionError(message)
        return self._preflight

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Record the enqueue payload and return a minimal queued record."""
        self.created.append((task_id, spec, attempt_id))
        return TaskRecord(
            task_id=task_id,
            spec=spec,
            state=LifecycleState.QUEUED,
            attempt_id=attempt_id,
            position=1,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )


class ManualDispatcher:
    """Captures submitted work; run_one executes it deterministically.

    Mirrors :class:`WorkDispatcher` but never touches a thread, so tests drive
    the planning state machine one step at a time and can observe the loading
    state before the outcome arrives.
    """

    def __init__(self) -> None:
        """Open an empty pending work queue."""
        self.pending: list[
            tuple[
                Callable[[], object],
                Callable[[object], None],
                Callable[[BaseException], None],
            ]
        ] = []

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
        except (HubFetchError, OSError, ValueError) as error:
            on_error(error)
        else:
            on_result(result)


class ControllableIdFactory:
    """Branded identifier factory returning predictable sequential ids."""

    task_calls: int
    attempt_calls: int

    def __init__(self) -> None:
        """Start the task and attempt counters at one."""
        self.task_calls = 0
        self.attempt_calls = 0

    def new_task_id(self) -> TaskId:
        """Return ``task-<n>`` and increment the counter."""
        self.task_calls += 1
        return parse_task_id(f"task-{self.task_calls}")

    def new_attempt_id(self) -> AttemptId:
        """Return ``attempt-<n>`` and increment the counter."""
        self.attempt_calls += 1
        return parse_attempt_id(f"attempt-{self.attempt_calls}")


__all__ = [
    "DEFAULT_COMMIT",
    "SENTINEL",
    "ControllableIdFactory",
    "FakeCloneService",
    "FakeDownloadService",
    "ManualDispatcher",
    "make_plan",
    "make_preflight",
    "make_repository",
]
