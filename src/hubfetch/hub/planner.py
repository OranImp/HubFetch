"""Plan one single-file or snapshot transfer before any bytes move.

The planner is the Todo 17 orchestration seam: it validates the requested
revision, resolves it through the pinned adapter, runs the library dry-run to
get selected files, byte totals, and cache hit/miss estimates, and then asks
Todo 11 for a free-space assessment of the destination volume. The proxy
policy itself was validated by the adapter's constructor (Todo 10 parity);
this module never mutates any environment. No transfer bytes are moved by
anything in this module.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal

from hubfetch.diagnostics.disk import SpaceAssessment, assess_space
from hubfetch.domain.errors import ErrorCategory, error_for
from hubfetch.domain.task_spec import (
    CacheDestination,
    LocalDirectoryDestination,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)

from .contracts import (
    DEFAULT_REVISION,
    FULL_COMMIT_HASH_LENGTH,
    HubAdapterProtocol,
    PlannedFile,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from hubfetch.domain.repository import RepositoryRef

DiskAssessor = Callable[[Path, int | None], SpaceAssessment]
"""The disk-assessment seam (Todo 11), injectable for deterministic tests."""

_HEX_DIGITS: Final = "0123456789abcdefABCDEF"


@dataclass(frozen=True, slots=True)
class DownloadPlan:
    """A complete preflight plan safe to render before the user confirms.

    ``total_bytes`` is ``None`` only when a selected file's size is unknown;
    the disk assessment is then ``sufficient=None`` rather than a fabricated
    claim of enough free space.
    """

    repository: RepositoryRef
    kind: Literal["file", "snapshot"]
    resolved_commit: str
    destination: Path
    selected_files: tuple[PlannedFile, ...]
    total_bytes: int | None
    cache_hits: int
    cache_misses: int
    space: SpaceAssessment


def _validate_revision(revision: str | None) -> str:
    """Validate a branch, tag, or full commit revision at the input boundary."""
    if revision is None:
        return DEFAULT_REVISION
    if not revision or "\x00" in revision:
        raise error_for(
            ErrorCategory.VALIDATION, detail="revision is empty or contains a NUL"
        )
    if len(revision) == FULL_COMMIT_HASH_LENGTH and not all(
        char in _HEX_DIGITS for char in revision
    ):
        raise error_for(
            ErrorCategory.VALIDATION,
            detail="commit-length revision must be hexadecimal",
        )
    return revision


def _total_bytes(files: Sequence[PlannedFile]) -> int | None:
    """Return the sum of known file sizes, or None when any size is unknown."""
    total = 0
    for file in files:
        size = file.size_bytes
        if size is None:
            return None
        total += size
    return total


class DownloadPlanner:
    """Compose adapter dry-run results and disk readiness into one plan.

    Args:
        adapter: The pinned Hub adapter (or a deterministic in-memory fake of
            the same protocol) that performs the actual dry-run calls.
        disk: Todo 11 space assessment, injectable for disk-full/unknown tests.
    """

    __slots__: Final = ("_adapter", "_disk")

    _adapter: HubAdapterProtocol
    _disk: DiskAssessor

    def __init__(
        self,
        adapter: HubAdapterProtocol,
        *,
        disk: DiskAssessor = assess_space,
    ) -> None:
        """Bind the pinned adapter and the injectable disk assessor."""
        self._adapter = adapter
        self._disk = disk

    def plan(self, spec: SingleFileDownloadSpec | SnapshotDownloadSpec) -> DownloadPlan:
        """Plan one download specification into a preflight estimate."""
        match spec:
            case SingleFileDownloadSpec():
                return self._plan_file(spec)
            case SnapshotDownloadSpec():
                return self._plan_snapshot(spec)

    def _plan_file(self, spec: SingleFileDownloadSpec) -> DownloadPlan:
        repository = spec.repository
        revision = _validate_revision(repository.revision)
        inspection = self._adapter.inspect_repository(repository, revision=revision)
        estimate = self._adapter.plan_single_file(
            repository,
            filename=spec.filename,
            revision=inspection.resolved_commit,
        )
        destination = self._destination(spec.destination)
        total = estimate.file.size_bytes
        return DownloadPlan(
            repository=repository,
            kind="file",
            resolved_commit=estimate.resolved_commit,
            destination=destination,
            selected_files=(estimate.file,),
            total_bytes=total,
            cache_hits=1 if estimate.file.cached else 0,
            cache_misses=1 if estimate.file.will_download else 0,
            space=self._disk(destination, total),
        )

    def _plan_snapshot(self, spec: SnapshotDownloadSpec) -> DownloadPlan:
        repository = spec.repository
        revision = _validate_revision(repository.revision)
        inspection = self._adapter.inspect_repository(repository, revision=revision)
        estimate = self._adapter.plan_snapshot(
            repository,
            revision=inspection.resolved_commit,
            include_patterns=spec.include_patterns,
            exclude_patterns=spec.exclude_patterns,
        )
        destination = self._destination(spec.destination)
        total = _total_bytes(estimate.files)
        return DownloadPlan(
            repository=repository,
            kind="snapshot",
            resolved_commit=estimate.resolved_commit,
            destination=destination,
            selected_files=estimate.files,
            total_bytes=total,
            cache_hits=sum(1 for file in estimate.files if file.cached),
            cache_misses=sum(1 for file in estimate.files if file.will_download),
            space=self._disk(destination, total),
        )

    def _destination(self, mode: CacheDestination | LocalDirectoryDestination) -> Path:
        """Resolve the effective destination path for the disk assessment."""
        match mode:
            case CacheDestination():
                return self._adapter.cache_directory()
            case LocalDirectoryDestination() as local:
                return local.path
