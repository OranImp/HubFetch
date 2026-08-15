"""Typed contracts shared by the transient Download and Clone creation flows.

The two creation dialogs are standalone Qt surfaces composed over typed service
seams so the GUI thread never performs network or subprocess work: planning and
preflight run off-thread through a :class:`WorkDispatcher`, and enqueueing goes
through the application runtime's typed create command. Every value crossing
those seams is a frozen dataclass, a closed enum, or a branded domain model;
raw dicts and ``Any`` never appear in public signatures.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

from hubfetch.domain.ids import parse_attempt_id, parse_task_id

if TYPE_CHECKING:
    from pathlib import Path

    from hubfetch.diagnostics.git import GitDependencyReport
    from hubfetch.domain.ids import AttemptId, TaskId
    from hubfetch.domain.task_spec import (
        SingleFileDownloadSpec,
        SnapshotDownloadSpec,
        TaskSpec,
    )
    from hubfetch.hub.planner import DownloadPlan
    from hubfetch.persistence.records import TaskRecord


@unique
class CreateFlowState(StrEnum):
    """Closed status of one transient creation flow.

    EDITING accepts input; PLANNING runs off-thread work; PLANNED shows
    estimates and enables confirm; FAILED shows one inline recovery action.
    """

    EDITING = "editing"
    PLANNING = "planning"
    PLANNED = "planned"
    FAILED = "failed"


@unique
class DownloadMode(StrEnum):
    """Whether the download flow targets one file or a filtered snapshot."""

    FILE = "file"
    SNAPSHOT = "snapshot"


@unique
class DestinationChoice(StrEnum):
    """Where download files land: the Hub cache or a selected local directory."""

    CACHE = "cache"
    LOCAL = "local_directory"


@unique
class ConflictChoice(StrEnum):
    """Explicit download conflict policy selected before planning."""

    OVERWRITE = "overwrite_existing"
    PRESERVE = "preserve_existing"
    FAIL = "fail_on_existing"


@unique
class TransportChoice(StrEnum):
    """Clone transport: HTTPS derived from a repo reference, or a validated SSH URL."""

    HTTPS = "https"
    SSH = "ssh"


@dataclass(frozen=True, slots=True)
class FieldError:
    """One inline field validation failure identified by a stable machine code."""

    field: str
    code: str


@dataclass(frozen=True, slots=True)
class CloneDestinationCheck:
    """Todo 19 empty-destination verdict for one clone target."""

    ready: bool
    detail: str
    category: str


@dataclass(frozen=True, slots=True)
class ClonePreflight:
    """Combined Todo 12 + Todo 19 readiness for one clone destination."""

    git: GitDependencyReport
    destination: CloneDestinationCheck
    ready: bool
    guidance: tuple[str, ...]


class DownloadCreateService(Protocol):
    """The seam that plans a download and enqueues it off the GUI thread."""

    def plan(self, spec: SingleFileDownloadSpec | SnapshotDownloadSpec) -> DownloadPlan:
        """Run Todo 17 planning for one download specification."""
        ...

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Persist one confirmed task through the application runtime."""
        ...


class CloneCreateService(Protocol):
    """The seam that preflights and enqueues one working-copy clone."""

    def preflight(self, destination: Path) -> ClonePreflight:
        """Run Todo 12 dependency and Todo 19 destination preflight."""
        ...

    def create(
        self, task_id: TaskId, spec: TaskSpec, attempt_id: AttemptId
    ) -> TaskRecord:
        """Persist one confirmed task through the application runtime."""
        ...


class TaskIdFactory(Protocol):
    """Generate the branded task and attempt identifiers for one confirmation."""

    def new_task_id(self) -> TaskId:
        """Return a fresh branded task identifier."""
        ...

    def new_attempt_id(self) -> AttemptId:
        """Return a fresh branded attempt identifier."""
        ...


class UuidTaskIdFactory:
    """Deterministic enough identifier factory seeding ids from ``uuid4``."""

    def new_task_id(self) -> TaskId:
        """Return ``task-<hex>``; identifiers never enter URLs or argv."""
        return parse_task_id(f"task-{uuid4().hex}")

    def new_attempt_id(self) -> AttemptId:
        """Return ``attempt-<hex>``."""
        return parse_attempt_id(f"attempt-{uuid4().hex}")


class WorkDispatcher(Protocol):
    """Run one unit of planning/preflight work off the GUI thread.

    ``on_result`` and ``on_error`` are invoked later, on the GUI thread, with
    the typed outcome or the boundary exception that escaped the work.
    """

    def submit(
        self,
        work: Callable[[], object],
        on_result: Callable[[object], None],
        on_error: Callable[[BaseException], None],
    ) -> None:
        """Queue ``work``; deliver its result or error back on the GUI thread."""
        ...


if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = [
    "CloneCreateService",
    "CloneDestinationCheck",
    "ClonePreflight",
    "ConflictChoice",
    "CreateFlowState",
    "DestinationChoice",
    "DownloadCreateService",
    "DownloadMode",
    "FieldError",
    "TaskIdFactory",
    "TransportChoice",
    "UuidTaskIdFactory",
    "WorkDispatcher",
]
