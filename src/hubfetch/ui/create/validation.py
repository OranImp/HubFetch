"""Pure validation and typed specification building for the creation flows.

# noqa: SIZE_OK - one module must own the pure boundary of both creation
# flows: the two values dataclasses, every field rule, the Todo 19 destination
# verdict, and the strict spec builders; splitting it would scatter one
# validation contract across modules.

Raw form values are captured into frozen :class:`DownloadValues` and
:class:`CloneValues` dataclasses, validated by pure functions that return a
stable ``FieldError`` code per problem, and only then compiled into strict
domain task specifications. The clone destination rule (Todo 19) lives here:
a clone target must be absent or empty, and that verdict is checked both
inline and again during preflight. Nothing in this module touches Qt.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Final
from urllib.parse import urlsplit

from hubfetch.domain.ids import parse_repository_id
from hubfetch.domain.repository import (
    REPO_ID_PART_COUNT,
    DatasetRepository,
    ModelRepository,
    RepositoryRef,
    SpaceRepository,
)
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    FailOnExisting,
    GitCloneSpec,
    LocalDirectoryDestination,
    OverwriteExisting,
    PreserveExisting,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.git.clone_url import CloneUrlError, ssh_clone_url
from hubfetch.network.proxy import ProxyPolicyError, build_proxy_policy
from hubfetch.ui.widgets.selectors import RepositoryTypeChoice

from .contracts import (
    CloneDestinationCheck,
    ConflictChoice,
    DestinationChoice,
    DownloadMode,
    FieldError,
    TransportChoice,
)

_HEX_DIGITS: Final = "0123456789abcdefABCDEF"
_FULL_COMMIT_LENGTH: Final = 40

_FIELD_REPO_ID = "repo_id"
_FIELD_SSH_URL = "ssh_url"
_FIELD_REVISION = "revision"
_FIELD_FILENAME = "filename"
_FIELD_PATTERNS = "patterns"
_FIELD_DESTINATION = "destination"
_FIELD_PROXY = "proxy"


@dataclass(frozen=True, slots=True)
class DownloadValues:
    """Raw field values captured from the download form before validation."""

    mode: DownloadMode
    repo_kind: RepositoryTypeChoice
    repo_id: str
    revision: str
    filename: str
    include_patterns: str
    exclude_patterns: str
    destination: DestinationChoice
    local_path: str
    conflict_policy: ConflictChoice
    auth_source: AuthSource
    proxy_mode: ProxyMode
    manual_proxy_url: str


@dataclass(frozen=True, slots=True)
class CloneValues:
    """Raw field values captured from the clone form before validation."""

    transport: TransportChoice
    repo_kind: RepositoryTypeChoice
    repo_id: str
    ssh_url: str
    revision: str
    shallow: bool
    destination: str
    auth_source: AuthSource
    proxy_mode: ProxyMode
    manual_proxy_url: str


def _repo_id_error(raw: str) -> FieldError | None:
    """Mirror the domain ``author/name`` boundary for an inline field error."""
    parts = raw.split("/")
    if len(parts) != REPO_ID_PART_COUNT or any(not part for part in parts):
        return FieldError(field=_FIELD_REPO_ID, code="repo_id.format")
    if any("\x00" in part or " " in part for part in parts):
        return FieldError(field=_FIELD_REPO_ID, code="repo_id.chars")
    return None


def _revision_error(raw: str) -> FieldError | None:
    """Mirror the planner revision rule for an inline field error."""
    if not raw:
        return None
    if "\x00" in raw:
        return FieldError(field=_FIELD_REVISION, code="revision.chars")
    if len(raw) == _FULL_COMMIT_LENGTH and not all(char in _HEX_DIGITS for char in raw):
        return FieldError(field=_FIELD_REVISION, code="revision.hex")
    return None


def _patterns_error(raw: str) -> FieldError | None:
    """Reject empty or NUL-bearing newline-separated include/exclude lines."""
    for line in raw.splitlines():
        if not line:
            return FieldError(field=_FIELD_PATTERNS, code="patterns.empty_line")
        if "\x00" in line:
            return FieldError(field=_FIELD_PATTERNS, code="patterns.nul")
    return None


def _proxy_error(raw: str) -> FieldError | None:
    """Validate a manual proxy URL only when manual mode is selected."""
    try:
        _ = build_proxy_policy(ProxyMode.MANUAL, raw)
    except ProxyPolicyError:
        return FieldError(field=_FIELD_PROXY, code="proxy.invalid")
    return None


def _local_path_error(raw: str) -> FieldError | None:
    """Reject empty and NUL-bearing local download destinations."""
    if not raw.strip():
        return FieldError(field=_FIELD_DESTINATION, code="destination.empty")
    if "\x00" in raw:
        return FieldError(field=_FIELD_DESTINATION, code="destination.chars")
    return None


def _ssh_url_error(raw: str) -> FieldError | None:
    """Validate one user-provided SSH URL through the strict URL boundary."""
    try:
        _ = ssh_clone_url(raw)
    except CloneUrlError:
        return FieldError(field=_FIELD_SSH_URL, code="ssh_url.invalid")
    return None


def validate_download_values(values: DownloadValues) -> tuple[FieldError, ...]:
    """Return every inline field error for the current download form values."""
    errors: list[FieldError] = []
    errors.extend(_download_repository_errors(values))
    errors.extend(_download_mode_errors(values))
    errors.extend(_download_destination_proxy_errors(values))
    return tuple(errors)


def _download_repository_errors(values: DownloadValues) -> tuple[FieldError, ...]:
    """Collect the repository identifier and revision field errors."""
    errors: list[FieldError] = []
    repo_id_error = _repo_id_error(values.repo_id)
    if repo_id_error is not None:
        errors.append(repo_id_error)
    revision_error = _revision_error(values.revision)
    if revision_error is not None:
        errors.append(revision_error)
    return tuple(errors)


def _download_mode_errors(values: DownloadValues) -> tuple[FieldError, ...]:
    """Collect the file-filename or snapshot-pattern field errors."""
    if values.mode is DownloadMode.FILE:
        if not values.filename or "\x00" in values.filename:
            return (FieldError(field=_FIELD_FILENAME, code="filename.empty"),)
        return ()
    include_error = _patterns_error(values.include_patterns)
    exclude_error = _patterns_error(values.exclude_patterns)
    return tuple(error for error in (include_error, exclude_error) if error is not None)


def _download_destination_proxy_errors(
    values: DownloadValues,
) -> tuple[FieldError, ...]:
    """Collect the local-destination and manual-proxy field errors."""
    errors: list[FieldError] = []
    if values.destination is DestinationChoice.LOCAL:
        local_error = _local_path_error(values.local_path)
        if local_error is not None:
            errors.append(local_error)
    if values.proxy_mode is ProxyMode.MANUAL:
        proxy_error = _proxy_error(values.manual_proxy_url)
        if proxy_error is not None:
            errors.append(proxy_error)
    return tuple(errors)


def _clone_destination_error(raw: str) -> FieldError | None:
    """Enforce the Todo 19 rule: a clone target must be absent or empty."""
    if not raw.strip():
        return FieldError(field=_FIELD_DESTINATION, code="destination.empty")
    if "\x00" in raw:
        return FieldError(field=_FIELD_DESTINATION, code="destination.chars")
    path = Path(raw)
    if not path.exists():
        return None
    if not path.is_dir():
        return FieldError(field=_FIELD_DESTINATION, code="destination.not_directory")
    if any(path.iterdir()):
        return FieldError(field=_FIELD_DESTINATION, code="destination.not_empty")
    return None


def validate_clone_values(values: CloneValues) -> tuple[FieldError, ...]:
    """Return every inline field error for the current clone form values."""
    errors: list[FieldError] = []
    if values.transport is TransportChoice.SSH:
        ssh_error = _ssh_url_error(values.ssh_url)
        if ssh_error is not None:
            errors.append(ssh_error)
        elif _ssh_repo_id(ssh_clone_url(values.ssh_url).value) is None:
            errors.append(FieldError(field=_FIELD_SSH_URL, code="ssh_url.not_hf_repo"))
    else:
        repo_id_error = _repo_id_error(values.repo_id)
        if repo_id_error is not None:
            errors.append(repo_id_error)
    revision_error = _revision_error(values.revision)
    if revision_error is not None:
        errors.append(revision_error)
    destination_error = _clone_destination_error(values.destination)
    if destination_error is not None:
        errors.append(destination_error)
    if values.proxy_mode is ProxyMode.MANUAL:
        proxy_error = _proxy_error(values.manual_proxy_url)
        if proxy_error is not None:
            errors.append(proxy_error)
    return tuple(errors)


def check_clone_destination(destination: Path) -> CloneDestinationCheck:
    """Return the Todo 19 absent-or-empty verdict for one clone destination."""
    if not destination.exists():
        return CloneDestinationCheck(
            ready=True, detail="destination.absent", category="absent"
        )
    if not destination.is_dir():
        return CloneDestinationCheck(
            ready=False, detail="destination.not_directory", category="not_directory"
        )
    if any(destination.iterdir()):
        return CloneDestinationCheck(
            ready=False, detail="destination.not_empty", category="not_empty"
        )
    return CloneDestinationCheck(
        ready=True, detail="destination.empty", category="empty"
    )


def _repository_ref(
    kind: RepositoryTypeChoice, repo_id: str, revision: str | None
) -> RepositoryRef:
    """Build one strict repository reference from validated form inputs."""
    match kind:
        case RepositoryTypeChoice.MODEL:
            repository_kind = ModelRepository()
        case RepositoryTypeChoice.DATASET:
            repository_kind = DatasetRepository()
        case RepositoryTypeChoice.SPACE:
            repository_kind = SpaceRepository()
    return RepositoryRef(
        repo_id=parse_repository_id(repo_id), kind=repository_kind, revision=revision
    )


def build_download_spec(
    values: DownloadValues,
) -> SingleFileDownloadSpec | SnapshotDownloadSpec:
    """Compile validated download values into one strict task specification."""
    revision = values.revision or None
    repository = _repository_ref(values.repo_kind, values.repo_id, revision)
    match values.destination:
        case DestinationChoice.CACHE:
            destination: CacheDestination | LocalDirectoryDestination = (
                CacheDestination()
            )
        case DestinationChoice.LOCAL:
            destination = LocalDirectoryDestination(path=Path(values.local_path))
    match values.conflict_policy:
        case ConflictChoice.OVERWRITE:
            conflict = OverwriteExisting()
        case ConflictChoice.PRESERVE:
            conflict = PreserveExisting()
        case ConflictChoice.FAIL:
            conflict = FailOnExisting()
    if values.mode is DownloadMode.FILE:
        return SingleFileDownloadSpec(
            kind="single_file",
            repository=repository,
            filename=values.filename,
            destination=destination,
            conflict_policy=conflict,
            auth_source=values.auth_source,
            proxy_mode=values.proxy_mode,
        )
    return SnapshotDownloadSpec(
        kind="snapshot",
        repository=repository,
        include_patterns=tuple(_split_patterns(values.include_patterns)),
        exclude_patterns=tuple(_split_patterns(values.exclude_patterns)),
        destination=destination,
        conflict_policy=conflict,
        auth_source=values.auth_source,
        proxy_mode=values.proxy_mode,
    )


def build_clone_spec(values: CloneValues) -> GitCloneSpec:
    """Compile validated clone values into one strict Git clone specification.

    The persisted contract carries only a :class:`RepositoryRef`, never a raw
    URL, so an SSH-mode input is reduced to its repository identity after the
    URL boundary validated it; the URL itself is not persisted.
    """
    revision = values.revision or None
    if values.transport is TransportChoice.SSH:
        repo_id = _ssh_repo_id(ssh_clone_url(values.ssh_url).value)
        if repo_id is None:
            raise CloneUrlError(reason="SSH URL does not identify an author/name repo")
    else:
        repo_id = values.repo_id
    repository = _repository_ref(values.repo_kind, repo_id, revision)
    return GitCloneSpec(
        kind="git_clone",
        repository=repository,
        destination=Path(values.destination),
        auth_source=values.auth_source,
        proxy_mode=values.proxy_mode,
    )


def _split_patterns(raw: str) -> tuple[str, ...]:
    """Return the non-empty newline-separated pattern lines."""
    return tuple(line for line in raw.splitlines() if line)


def _ssh_repo_id(ssh_value: str) -> str | None:
    """Extract an ``author/name`` repository identity from a validated SSH URL.

    Both ``ssh://user@host/org/repo`` and ``user@host:org/repo`` layouts are
    reduced to their path segment; a path that is not exactly an
    ``author/name`` pair returns ``None`` so the form can report it inline.
    """
    if ssh_value.startswith("ssh://"):
        path = urlsplit(ssh_value).path
    else:
        _user, separator, target = ssh_value.partition("@")
        _host, colon, path = (target if separator else ssh_value).partition(":")
        if not colon:
            return None
    repo_id = path.strip("/").removesuffix(".git")
    parts = repo_id.split("/")
    if len(parts) != REPO_ID_PART_COUNT or any(not part for part in parts):
        return None
    if any("\x00" in part or " " in part for part in parts):
        return None
    return repo_id


__all__ = [
    "CloneValues",
    "DownloadValues",
    "build_clone_spec",
    "build_download_spec",
    "check_clone_destination",
    "validate_clone_values",
    "validate_download_values",
]
