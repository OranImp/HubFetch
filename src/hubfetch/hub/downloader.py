# pyright: reportUnknownVariableType = false
# pyright: reportUnknownMemberType = false
# pyright: reportUnknownArgumentType = false
# pyright: reportArgumentType = false
# pyright: reportCallIssue = false
"""Execute resumable Hub file and snapshot downloads through the pinned library.

This module owns the download execution surface. It calls ONLY
``hf_hub_download`` and ``snapshot_download`` from the pinned 1.27.0 library
(the adapter owns repo-info inspection and dry-run planning). Conflict policies
map to explicit library behavior: ``overwrite_existing`` sets
``force_download=True`` (an explicit user choice, never an ordinary retry);
``preserve_existing`` keeps the library default so cached and partial data
resume automatically; ``fail_on_existing`` runs a ``local_files_only`` probe
first and raises a typed disk conflict before any byte moves. Cancellation is
cooperative: the progress sink raises a typed :class:`CancellationError` from
inside a library call, which unwinds here and preserves every cache/partial
artifact the library already wrote.

The ``pyright`` directives mirror ``hubfetch.hub.adapter`` with one extension:
the 1.27.0 stubs type ``tqdm_class`` as ``type[tqdm_asyncio]`` even though any
tqdm-mimicking class is documented as accepted, so no overload of the two
download callables matches this module's call shape. ``reportCallIssue`` is
relaxed in exactly this module; ``tests/hub/test_downloader.py`` pins the real
runtime behavior.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, final

from huggingface_hub import constants as hub_constants
from huggingface_hub import hf_hub_download, snapshot_download
from huggingface_hub.errors import IncompleteSnapshotError, LocalEntryNotFoundError

from hubfetch.domain.errors import ErrorCategory, HubFetchError, error_for
from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryKind,
    SpaceRepository,
)
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    FailOnExisting,
    LocalDirectoryDestination,
    OverwriteExisting,
    PreserveExisting,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.network.proxy import ProxyPolicyError, build_proxy_policy

from .auth import resolve_auth
from .contracts import (
    DEFAULT_REVISION,
    REPO_TYPE_DATASET,
    REPO_TYPE_MODEL,
    REPO_TYPE_SPACE,
)
from .error_mapping import HUB_ERROR_TYPES, normalize_hub_error

if TYPE_CHECKING:
    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore
    from hubfetch.domain.repository import RepositoryRef
    from hubfetch.domain.task_spec import DestinationMode

    from .progress import ProgressSink

__all__ = ["DownloadResult", "HubDownloader"]

HubRepoType = Literal["model", "dataset", "space"]
DownloadSpec = SingleFileDownloadSpec | SnapshotDownloadSpec


@dataclass(frozen=True, slots=True)
class DownloadResult:
    """The materialized outcome of one executed download."""

    destination: Path
    paths: tuple[Path, ...]


def _revision(repository: RepositoryRef) -> str:
    # Branch, tag, or commit revision, defaulting to ``main``.
    return repository.revision or DEFAULT_REVISION


def _map_os_error(error: OSError) -> HubFetchError:
    """Map a library OSError: consistency failures are network, else disk."""
    if "Consistency check failed" in str(error):
        return error_for(ErrorCategory.NETWORK, detail="content consistency failed")
    return error_for(ErrorCategory.DISK, detail="filesystem error while downloading")


@final
class HubDownloader:
    """Execute one download specification through the pinned Hub library."""

    def __init__(  # noqa: PLR0913 - config bundle with auth/proxy/destination
        self,
        *,
        auth_source: AuthSource,
        proxy_mode: ProxyMode,
        credential_alias: CredentialAlias | None = None,
        credential_store: CredentialStore | None = None,
        manual_proxy_url: str | None = None,
        endpoint: str | None = None,
        etag_timeout: float | None = None,
        cache_dir: Path | None = None,
    ) -> None:
        """Validate proxy and auth eagerly, then bind transport and cache."""
        try:
            _ = build_proxy_policy(proxy_mode, manual_proxy_url)
        except ProxyPolicyError as error:
            raise error_for(
                ErrorCategory.VALIDATION, detail="invalid proxy policy"
            ) from error
        self._auth = resolve_auth(
            auth_source, alias=credential_alias, store=credential_store
        )
        self._endpoint = endpoint
        self._etag_timeout = (
            etag_timeout
            if etag_timeout is not None
            else hub_constants.DEFAULT_ETAG_TIMEOUT
        )
        self._cache_dir = (
            Path(cache_dir)
            if cache_dir is not None
            else Path(hub_constants.HF_HUB_CACHE)
        )

    def download(self, spec: DownloadSpec, *, progress: ProgressSink) -> DownloadResult:
        """Execute one file or snapshot specification through the library."""
        destination, local_dir = self._destination(spec.destination)
        force = self._force_download(spec.conflict_policy)
        progress.checkpoint()
        match spec.conflict_policy:
            case FailOnExisting():
                self._probe_exists(spec, local_dir)
            case OverwriteExisting() | PreserveExisting():
                pass
        progress.checkpoint()
        try:
            returned = self._call(spec, force, local_dir, progress)
        except HUB_ERROR_TYPES as error:
            raise normalize_hub_error(
                error, authenticated=self._auth.authenticated
            ) from error
        except OSError as error:
            raise _map_os_error(error) from error
        progress.checkpoint()
        return DownloadResult(destination=destination, paths=(Path(returned),))

    def _call(
        self,
        spec: DownloadSpec,
        force: bool,
        local_dir: Path | None,
        progress: ProgressSink,
    ) -> str:
        """Dispatch one pinned library download call for the spec kind."""
        match spec:
            case SingleFileDownloadSpec() as file_spec:
                return hf_hub_download(
                    str(file_spec.repository.repo_id),
                    filename=file_spec.filename,
                    repo_type=self._repo_type(file_spec.repository.kind),
                    revision=_revision(file_spec.repository),
                    cache_dir=str(self._cache_dir),
                    local_dir=str(local_dir) if local_dir is not None else None,
                    token=self._auth.token,
                    endpoint=self._endpoint,
                    force_download=force,
                    etag_timeout=self._etag_timeout,
                    tqdm_class=progress.bar_class(),
                    dry_run=False,
                )
            case SnapshotDownloadSpec() as snap_spec:
                return snapshot_download(
                    str(snap_spec.repository.repo_id),
                    repo_type=self._repo_type(snap_spec.repository.kind),
                    revision=_revision(snap_spec.repository),
                    cache_dir=str(self._cache_dir),
                    local_dir=str(local_dir) if local_dir is not None else None,
                    token=self._auth.token,
                    endpoint=self._endpoint,
                    allow_patterns=(
                        list(snap_spec.include_patterns)
                        if snap_spec.include_patterns
                        else None
                    ),
                    ignore_patterns=(
                        list(snap_spec.exclude_patterns)
                        if snap_spec.exclude_patterns
                        else None
                    ),
                    force_download=force,
                    etag_timeout=self._etag_timeout,
                    tqdm_class=progress.bar_class(),
                    dry_run=False,
                )

    def _probe_exists(self, spec: DownloadSpec, local_dir: Path | None) -> None:
        """Raise a disk conflict when the destination already holds the target."""
        try:
            match spec:
                case SingleFileDownloadSpec() as file_spec:
                    _ = hf_hub_download(
                        str(file_spec.repository.repo_id),
                        filename=file_spec.filename,
                        repo_type=self._repo_type(file_spec.repository.kind),
                        revision=_revision(file_spec.repository),
                        cache_dir=str(self._cache_dir),
                        local_dir=str(local_dir) if local_dir is not None else None,
                        token=self._auth.token,
                        endpoint=self._endpoint,
                        local_files_only=True,
                        dry_run=False,
                    )
                case SnapshotDownloadSpec() as snap_spec:
                    _ = snapshot_download(
                        str(snap_spec.repository.repo_id),
                        repo_type=self._repo_type(snap_spec.repository.kind),
                        revision=_revision(snap_spec.repository),
                        cache_dir=str(self._cache_dir),
                        local_dir=str(local_dir) if local_dir is not None else None,
                        token=self._auth.token,
                        endpoint=self._endpoint,
                        allow_patterns=(
                            list(snap_spec.include_patterns)
                            if snap_spec.include_patterns
                            else None
                        ),
                        ignore_patterns=(
                            list(snap_spec.exclude_patterns)
                            if snap_spec.exclude_patterns
                            else None
                        ),
                        local_files_only=True,
                        dry_run=False,
                    )
        except (LocalEntryNotFoundError, IncompleteSnapshotError):
            return  # absent or partial → library-native resume is safe
        raise error_for(
            ErrorCategory.DISK, detail="destination already contains the target"
        )

    def _force_download(
        self,
        policy: OverwriteExisting | PreserveExisting | FailOnExisting,
    ) -> bool:
        # Overwrite is the only policy that forces a fresh network download.
        match policy:
            case OverwriteExisting():
                return True
            case PreserveExisting() | FailOnExisting():
                return False

    def _destination(
        self,
        mode: DestinationMode,
    ) -> tuple[Path, Path | None]:
        # Resolve the effective destination root and optional local directory.
        match mode:
            case CacheDestination():
                return self._cache_dir, None
            case LocalDirectoryDestination() as local:
                return local.path, local.path

    def _repo_type(self, kind: RepositoryKind) -> HubRepoType:
        match kind:
            case ModelRepository():
                return REPO_TYPE_MODEL
            case DatasetRepository():
                return REPO_TYPE_DATASET
            case SpaceRepository():
                return REPO_TYPE_SPACE
