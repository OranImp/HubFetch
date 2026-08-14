"""Strict tagged models for HubFetch download and clone task specifications.

A ``TaskSpec`` is a Pydantic discriminated union over three kinds: a
single-file download, a snapshot download, and a real Git clone. Download
specs carry a destination mode (Hub cache or a local directory) and a
conflict policy; the clone variant deliberately has neither, because Git
clone only supports an empty/new destination and never a per-file conflict
policy. Authentication and proxy policy are closed enums shared by every
kind.
"""

from dataclasses import dataclass
from enum import StrEnum, unique
from pathlib import Path
from typing import Annotated, ClassVar, Literal, override

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from .repository import RepositoryRef


class StrictModel(BaseModel):
    """Frozen boundary model that rejects unknown fields and stores no secrets."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True, slots=True)
class TaskSpecBoundaryError(ValueError):
    """A task specification field failed the strict boundary contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid task specification: {self.reason}"


@unique
class AuthSource(StrEnum):
    """Closed authentication sources for one task."""

    ANONYMOUS = "anonymous"
    SHARED_OAUTH = "shared_oauth"
    MANUAL_TOKEN = "manual_token"  # noqa: S105 - enum tag, not a credential


@unique
class ProxyMode(StrEnum):
    """Closed proxy policies for one task."""

    SYSTEM = "system"
    DIRECT = "direct"
    MANUAL = "manual"


class OverwriteExisting(StrictModel):
    """Existing destination files are replaced by fresh downloads."""

    kind: Literal["overwrite_existing"] = "overwrite_existing"


class PreserveExisting(StrictModel):
    """Existing destination files are kept; downloads skip them."""

    kind: Literal["preserve_existing"] = "preserve_existing"


class FailOnExisting(StrictModel):
    """The task fails rather than touch an existing destination file."""

    kind: Literal["fail_on_existing"] = "fail_on_existing"


ConflictPolicy = Annotated[
    OverwriteExisting | PreserveExisting | FailOnExisting,
    Field(discriminator="kind"),
]


class CacheDestination(StrictModel):
    """Files land in the versioned Hugging Face Hub cache."""

    kind: Literal["cache"] = "cache"


def _parse_destination_path(value: str | Path) -> str:
    """Validate a destination path from its raw string form.

    ``Path("")`` collapses to the current directory, so emptiness must be
    checked on the raw string. Returning the validated string lets pydantic's
    Path schema perform the coercion in both Python and JSON validation modes.
    """
    match value:
        case str() as raw:
            if not raw.strip():
                raise TaskSpecBoundaryError(reason="destination path is empty")
            if "\x00" in raw:
                raise TaskSpecBoundaryError(
                    reason="destination path contains a NUL character"
                )
            return raw
        case Path() as path:
            raw = str(path)
            if not raw.strip():
                raise TaskSpecBoundaryError(reason="destination path is empty")
            if "\x00" in raw:
                raise TaskSpecBoundaryError(
                    reason="destination path contains a NUL character"
                )
            return raw


DestinationPath = Annotated[Path, BeforeValidator(_parse_destination_path)]


class LocalDirectoryDestination(StrictModel):
    """Files land in an explicitly selected local directory."""

    kind: Literal["local_directory"] = "local_directory"
    path: DestinationPath


DestinationMode = Annotated[
    CacheDestination | LocalDirectoryDestination,
    Field(discriminator="kind"),
]


def _validate_filename(value: str) -> str:
    """Reject empty and NUL-bearing repository filenames."""
    if not value or "\x00" in value:
        raise TaskSpecBoundaryError(
            reason="filename is empty or contains a NUL character"
        )
    return value


def _validate_pattern_list(values: tuple[str, ...]) -> tuple[str, ...]:
    """Reject empty and NUL-bearing include/exclude patterns."""
    for pattern in values:
        if not pattern or "\x00" in pattern:
            raise TaskSpecBoundaryError(
                reason="pattern is empty or contains a NUL character"
            )
    return values


class TaskSpecBase(StrictModel):
    """Fields shared by every task kind."""

    auth_source: AuthSource
    proxy_mode: ProxyMode


class SingleFileDownloadSpec(TaskSpecBase):
    """Download exactly one file from a repository."""

    kind: Literal["single_file"] = "single_file"
    repository: RepositoryRef
    filename: str
    destination: DestinationMode
    conflict_policy: ConflictPolicy

    @field_validator("filename")
    @classmethod
    def _check_filename(cls, value: str) -> str:
        return _validate_filename(value)


class SnapshotDownloadSpec(TaskSpecBase):
    """Download a filtered or full snapshot of a repository."""

    kind: Literal["snapshot"] = "snapshot"
    repository: RepositoryRef
    include_patterns: tuple[str, ...]
    exclude_patterns: tuple[str, ...]
    destination: DestinationMode
    conflict_policy: ConflictPolicy

    @field_validator("include_patterns", "exclude_patterns")
    @classmethod
    def _check_patterns(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return _validate_pattern_list(value)


class GitCloneSpec(TaskSpecBase):
    """Clone a real Git working copy into an empty or new destination.

    There is intentionally no ``conflict_policy`` field: Git clone only
    accepts an empty or absent destination, so a non-empty overwrite policy
    is not representable in the type.
    """

    kind: Literal["git_clone"] = "git_clone"
    repository: RepositoryRef
    destination: DestinationPath


TaskSpec = Annotated[
    SingleFileDownloadSpec | SnapshotDownloadSpec | GitCloneSpec,
    Field(discriminator="kind"),
]
