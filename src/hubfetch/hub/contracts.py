"""Pinned Hugging Face Hub 1.27.0 contract and typed planning models.

Every Hub transfer in HubFetch is planned through this single pinned surface.
The constants below fix the exact library version, repository-type strings,
and revision rules the rest of the package relies on; the dataclasses are the
typed values exchanged between the adapter, the planner, and downstream
downloader handlers; and :class:`HubAdapterProtocol` is the seam the planner
depends on so deterministic in-memory fakes can drive planner-only tests.

The actual ``huggingface_hub`` callables are intentionally NOT imported here:
:mod:`hubfetch.hub.adapter` is the single module that owns the runtime Hub
API imports, and ``tests/hub/test_contracts.py`` proves the installed
1.27.0 signatures match the pinned parameter names and exception hierarchy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, Protocol

if TYPE_CHECKING:
    from pathlib import Path

    from hubfetch.domain.ids import RepositoryId
    from hubfetch.domain.repository import RepositoryRef

PINNED_HUB_VERSION: Final = "1.27.0"
"""The exact ``huggingface_hub`` version every planning path is pinned to."""

REPO_TYPE_MODEL: Final = "model"
REPO_TYPE_DATASET: Final = "dataset"
REPO_TYPE_SPACE: Final = "space"
"""Hub ``repo_type`` strings accepted by ``list_repo_files`` and downloads."""

DEFAULT_REVISION: Final = "main"
"""The revision used when a task does not pin one."""

FULL_COMMIT_HASH_LENGTH: Final = 40
"""Length of a full Git commit hash the Hub accepts as an immutable revision."""


@dataclass(frozen=True, slots=True)
class HubFile:
    """One repository file observed during inspection.

    ``size_bytes`` is the byte size reported by the Hub for a non-LFS file, or
    the LFS pointer-independent size; it is ``None`` when the Hub omits it.
    """

    path: str
    size_bytes: int | None


@dataclass(frozen=True, slots=True)
class PlannedFile:
    """One file selected by a dry-run plan, with its transfer assessment."""

    path: str
    size_bytes: int | None
    cached: bool
    will_download: bool


@dataclass(frozen=True, slots=True)
class RepositoryInspection:
    """Resolved repository state used to validate a revision before planning.

    ``resolved_commit`` is the immutable commit hash the requested branch,
    tag, or commit revision resolves to on the Hub.
    """

    repo_id: RepositoryId
    repo_type: Literal["model", "dataset", "space"]
    revision: str
    resolved_commit: str
    gated: bool
    private: bool
    files: tuple[HubFile, ...]


@dataclass(frozen=True, slots=True)
class SingleFileEstimate:
    """Dry-run assessment of exactly one file download."""

    resolved_commit: str
    file: PlannedFile


@dataclass(frozen=True, slots=True)
class SnapshotEstimate:
    """Dry-run assessment of a filtered or full snapshot download."""

    resolved_commit: str
    files: tuple[PlannedFile, ...]


class HubAdapterProtocol(Protocol):
    """The pinned adapter seam used by the planner and its fakes.

    Methods receive an already-validated revision (resolved commit) for the
    planning calls; revision existence and resolution happen in
    :meth:`inspect_repository`.
    """

    def cache_directory(self) -> Path:
        """Return the effective Hub cache directory for this task."""
        ...

    def inspect_repository(
        self, repository: RepositoryRef, *, revision: str
    ) -> RepositoryInspection:
        """Resolve one repository at a revision to its commit and files."""
        ...

    def plan_single_file(
        self, repository: RepositoryRef, *, filename: str, revision: str
    ) -> SingleFileEstimate:
        """Dry-run one file download and return its estimate."""
        ...

    def plan_snapshot(
        self,
        repository: RepositoryRef,
        *,
        revision: str,
        include_patterns: tuple[str, ...],
        exclude_patterns: tuple[str, ...],
    ) -> SnapshotEstimate:
        """Dry-run a filtered snapshot and return its estimates."""
        ...
