"""Shared typed helpers for Hub planner wire tests.

Reusable domain fixtures, an in-memory CredentialStore, an in-memory fake
adapter, and the spec/adapter builders the planner tests compose. Keeping
them here keeps each test module under the no-excuse size ceiling while
avoiding duplication.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, NamedTuple, override

from hubfetch.credentials.models import BackendIdentity, CredentialAlias
from hubfetch.credentials.port import (
    CredentialNotFoundError,
    CredentialStore,
)
from hubfetch.domain.ids import RepositoryId
from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryRef,
    SpaceRepository,
)
from hubfetch.domain.task_spec import (
    AuthSource,
    CacheDestination,
    OverwriteExisting,
    ProxyMode,
    SingleFileDownloadSpec,
    SnapshotDownloadSpec,
)
from hubfetch.hub.adapter import HubAdapter
from hubfetch.hub.contracts import (
    HubFile,
    RepositoryInspection,
    SingleFileEstimate,
    SnapshotEstimate,
)

if TYPE_CHECKING:
    from pathlib import Path

    from .fixtures import HubFixtureServer

from .fixtures import DEFAULT_COMMIT

FILES: Final = (
    ("config.json", 554),
    ("README.md", 391),
    ("pytorch_model.bin", 548123560),
    ("onnx/model.onnx", 700),
)
SHARED_TOKEN: Final = "hftok_shared_abc123"  # noqa: S105 - test token, not a credential
MANUAL_TOKEN: Final = "hftok_manual_xyz789"  # noqa: S105 - test token, not a credential
REPO_ID: Final = "org/repo"


class DiskUsage(NamedTuple):
    """NamedTuple matching ``os.statvfs_result`` for free-space control."""

    total: int
    used: int
    free: int


class InMemoryCredentialStore(CredentialStore):
    """Real in-memory CredentialStore implementation for adapter auth tests."""

    def __init__(self) -> None:
        self._tokens: dict[str, str] = {}

    @override
    def create(self, *, token: str) -> CredentialAlias:
        alias = CredentialAlias(f"hfc-{len(self._tokens):032x}")
        self._tokens[alias] = token
        return alias

    @override
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        self._tokens[alias] = token

    @override
    def resolve(self, alias: CredentialAlias) -> str:
        try:
            return self._tokens[alias]
        except KeyError as error:
            raise CredentialNotFoundError(reason=f"alias {alias!r} absent") from error

    @override
    def delete(self, alias: CredentialAlias) -> None:
        _ = self._tokens.pop(alias, None)

    @property
    @override
    def backend_identity(self) -> BackendIdentity:
        return BackendIdentity(
            module="tests.hub.helpers", class_name="InMemoryCredentialStore"
        )


class FakeHubAdapter:
    """Deterministic in-memory adapter for planner-only edge cases."""

    _cache_dir: Path
    _file_estimate: SingleFileEstimate
    _snapshot_estimate: SnapshotEstimate

    def __init__(
        self,
        *,
        cache_dir: Path,
        file_estimate: SingleFileEstimate,
        snapshot_estimate: SnapshotEstimate,
    ) -> None:
        self._cache_dir = cache_dir
        self._file_estimate = file_estimate
        self._snapshot_estimate = snapshot_estimate

    def cache_directory(self) -> Path:
        return self._cache_dir

    def inspect_repository(
        self, repository: RepositoryRef, *, revision: str
    ) -> RepositoryInspection:
        del repository, revision
        return RepositoryInspection(
            repo_id=RepositoryId(REPO_ID),
            repo_type="model",
            revision="main",
            resolved_commit=DEFAULT_COMMIT,
            gated=False,
            private=False,
            files=(HubFile(path="config.json", size_bytes=554),),
        )

    def plan_single_file(
        self, repository: RepositoryRef, *, filename: str, revision: str
    ) -> SingleFileEstimate:
        del repository, filename, revision
        return self._file_estimate

    def plan_snapshot(
        self,
        repository: RepositoryRef,
        *,
        revision: str,
        include_patterns: tuple[str, ...],
        exclude_patterns: tuple[str, ...],
    ) -> SnapshotEstimate:
        del repository, revision, include_patterns, exclude_patterns
        return self._snapshot_estimate


def make_repository(
    *,
    kind: type[ModelRepository | DatasetRepository | SpaceRepository] = ModelRepository,
    revision: str | None = None,
) -> RepositoryRef:
    """Build a strict repository reference with the pinned repo id."""
    return RepositoryRef(repo_id=RepositoryId(REPO_ID), kind=kind(), revision=revision)


def make_file_spec(
    repository: RepositoryRef,
    filename: str,
    *,
    auth: AuthSource = AuthSource.ANONYMOUS,
    proxy: ProxyMode = ProxyMode.SYSTEM,
) -> SingleFileDownloadSpec:
    """Build a single-file download spec into the Hub cache."""
    return SingleFileDownloadSpec(
        kind="single_file",
        repository=repository,
        filename=filename,
        destination=CacheDestination(),
        conflict_policy=OverwriteExisting(),
        auth_source=auth,
        proxy_mode=proxy,
    )


def make_snapshot_spec(
    repository: RepositoryRef,
    *,
    include: tuple[str, ...] = (),
    exclude: tuple[str, ...] = (),
    auth: AuthSource = AuthSource.ANONYMOUS,
    proxy: ProxyMode = ProxyMode.SYSTEM,
) -> SnapshotDownloadSpec:
    """Build a snapshot download spec into the Hub cache."""
    return SnapshotDownloadSpec(
        kind="snapshot",
        repository=repository,
        include_patterns=include,
        exclude_patterns=exclude,
        destination=CacheDestination(),
        conflict_policy=OverwriteExisting(),
        auth_source=auth,
        proxy_mode=proxy,
    )


def make_adapter(  # noqa: PLR0913 - bundles auth, credential, transport overrides
    fixture: HubFixtureServer,
    *,
    auth: AuthSource = AuthSource.ANONYMOUS,
    store: CredentialStore | None = None,
    alias: CredentialAlias | None = None,
    endpoint: str | None = None,
    cache_dir: Path | None = None,
) -> HubAdapter:
    """Build an adapter pinned to one fixture's endpoint."""
    return HubAdapter(
        auth_source=auth,
        proxy_mode=ProxyMode.SYSTEM,
        credential_store=store,
        credential_alias=alias,
        endpoint=endpoint if endpoint is not None else fixture.endpoint,
        cache_dir=cache_dir,
    )


def pointer(cache_dir: Path, commit: str, filename: str) -> Path:
    """Return the Hub cache pointer path for one file."""
    return cache_dir / "models--org--repo" / "snapshots" / commit / filename
