# pyright: reportUnknownVariableType = false
# pyright: reportUnknownMemberType = false
# pyright: reportUnknownArgumentType = false
"""Single pinned Hugging Face Hub adapter owning every Hub API call.

This module is the only place in the package that imports the
``huggingface_hub`` API surface (``HfApi`` and the module-level download
functions). Everything the planner, worker handlers, and UI need from the Hub
arrives through the typed :class:`HubAdapter` methods and the models in
:mod:`hubfetch.hub.contracts`.

The three ``pyright`` directives above are a scoped workaround for a
third-party stub defect: the 1.27.0 type stubs type ``hf_hub_download`` and
``snapshot_download`` with ``tqdm_asyncio[Unknown]`` and
``dict[Unknown, Unknown]`` parameters, so under ``typeCheckingMode = "all"``
any reference to those two callables is a "partially unknown" diagnostic.
The directives relax exactly those unknown-type rules in exactly this module;
the pinned signatures themselves are still proven by ``tests/hub`` contract
tests. No other module references the leaky callables.

Credential and proxy validation happen in the constructor, before any
authenticated request can be made: the app-token alias is resolved through
the Todo 8 credential store (or shared/anonymous auth is selected) and the
Todo 10 proxy policy is built and validated here. The worker process
environment is where Todo 10 actually applies proxy variables; this adapter
only consumes the validated policy.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal

from huggingface_hub import HfApi, hf_hub_download, snapshot_download
from huggingface_hub import constants as hub_constants

from hubfetch.domain.errors import ErrorCategory, error_for
from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryKind,
    RepositoryRef,
    SpaceRepository,
)
from hubfetch.network.proxy import ProxyPolicyError, build_proxy_policy

from .auth import ResolvedAuth, resolve_auth
from .contracts import (
    REPO_TYPE_DATASET,
    REPO_TYPE_MODEL,
    REPO_TYPE_SPACE,
    HubFile,
    PlannedFile,
    RepositoryInspection,
    SingleFileEstimate,
    SnapshotEstimate,
)
from .error_mapping import HUB_ERROR_TYPES, normalize_hub_error

if TYPE_CHECKING:
    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore
    from hubfetch.domain.task_spec import AuthSource, ProxyMode

__all__ = ["HubAdapter", "ResolvedAuth"]

HubRepoType = Literal["model", "dataset", "space"]
"""Closed repo-type strings understood by every pinned Hub call."""


class HubAdapter:
    """Pinned adapter for Hub repository inspection and dry-run planning.

    Args:
        auth_source: The closed authentication source for this task.
        proxy_mode: The closed per-task proxy mode (Todo 10 parity).
        credential_alias: Opaque alias resolved through ``credential_store``
            when ``auth_source`` is manual-token.
        credential_store: Todo 8 store used to resolve a manual-token alias.
        manual_proxy_url: Validated manual HTTP(S) proxy URL for manual mode.
        endpoint: Hub endpoint override (tests point this at a local fixture).
        timeout: Optional request timeout in seconds for repo-info calls.
        cache_dir: Cache directory; defaults to the library's resolved cache.
        local_dir: Local materialization directory when the task targets one.
    """

    __slots__: Final = (
        "_api",
        "_auth",
        "_cache_dir",
        "_endpoint",
        "_local_dir",
        "_timeout",
    )

    _api: HfApi
    _auth: ResolvedAuth
    _cache_dir: Path
    _endpoint: str | None
    _local_dir: Path | None
    _timeout: float | None

    # A Hub adapter is a deliberate config bundle: auth, proxy, credential
    # resolution, transport, and destination are each independent task inputs
    # that must be fixed before any request.
    def __init__(  # noqa: PLR0913
        self,
        *,
        auth_source: AuthSource,
        proxy_mode: ProxyMode,
        credential_alias: CredentialAlias | None = None,
        credential_store: CredentialStore | None = None,
        manual_proxy_url: str | None = None,
        endpoint: str | None = None,
        timeout: float | None = None,
        cache_dir: Path | None = None,
        local_dir: Path | None = None,
    ) -> None:
        """Validate proxy/auth eagerly, then bind transport and destination.

        Validation happens here, before any authenticated request: the proxy
        policy is built through the Todo 10 helper and the app-token alias is
        resolved through the Todo 8 credential store.
        """
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
        self._timeout = timeout
        self._cache_dir = (
            Path(cache_dir)
            if cache_dir is not None
            else Path(hub_constants.HF_HUB_CACHE)
        )
        self._local_dir = Path(local_dir) if local_dir is not None else None
        self._api = HfApi(endpoint=endpoint)

    def cache_directory(self) -> Path:
        """Return the effective Hub cache directory for this adapter."""
        return self._cache_dir

    def inspect_repository(
        self, repository: RepositoryRef, *, revision: str
    ) -> RepositoryInspection:
        """Resolve one repository at a revision to its commit and file tree.

        The requested branch, tag, or commit revision is validated against the
        Hub here; a missing repo or revision surfaces as a typed
        :class:`NotFoundError` before any download planning starts.
        """
        token = self._auth.token
        try:
            match repository.kind:
                case ModelRepository():
                    info = self._api.model_info(
                        str(repository.repo_id),
                        revision=revision,
                        token=token,
                        files_metadata=True,
                    )
                case DatasetRepository():
                    info = self._api.dataset_info(
                        str(repository.repo_id),
                        revision=revision,
                        token=token,
                        files_metadata=True,
                    )
                case SpaceRepository():
                    info = self._api.space_info(
                        str(repository.repo_id),
                        revision=revision,
                        token=token,
                        files_metadata=True,
                    )
        except HUB_ERROR_TYPES as error:
            raise normalize_hub_error(
                error, authenticated=self._auth.authenticated
            ) from error
        resolved = info.sha
        if resolved is None:
            raise error_for(
                ErrorCategory.NOT_FOUND, detail="hub did not return a resolved commit"
            )
        siblings = info.siblings if info.siblings is not None else ()
        files = tuple(
            HubFile(path=entry.rfilename, size_bytes=entry.size) for entry in siblings
        )
        return RepositoryInspection(
            repo_id=repository.repo_id,
            repo_type=self._repo_type(repository.kind),
            revision=revision,
            resolved_commit=resolved,
            gated=bool(info.gated),
            private=bool(info.private),
            files=files,
        )

    def plan_single_file(
        self, repository: RepositoryRef, *, filename: str, revision: str
    ) -> SingleFileEstimate:
        """Run the library dry-run for exactly one file and return its estimate."""
        try:
            result = hf_hub_download(
                str(repository.repo_id),
                filename=filename,
                repo_type=self._repo_type(repository.kind),
                revision=revision,
                cache_dir=str(self._cache_dir),
                local_dir=str(self._local_dir) if self._local_dir is not None else None,
                token=self._auth.token,
                endpoint=self._endpoint,
                dry_run=True,
            )
        except HUB_ERROR_TYPES as error:
            raise normalize_hub_error(
                error, authenticated=self._auth.authenticated
            ) from error
        planned = PlannedFile(
            path=result.filename,
            size_bytes=result.file_size,
            cached=result.is_cached,
            will_download=result.will_download,
        )
        return SingleFileEstimate(resolved_commit=result.commit_hash, file=planned)

    def plan_snapshot(
        self,
        repository: RepositoryRef,
        *,
        revision: str,
        include_patterns: tuple[str, ...],
        exclude_patterns: tuple[str, ...],
    ) -> SnapshotEstimate:
        """Run the library dry-run for a filtered snapshot and return estimates."""
        try:
            results = snapshot_download(
                str(repository.repo_id),
                repo_type=self._repo_type(repository.kind),
                revision=revision,
                cache_dir=str(self._cache_dir),
                local_dir=str(self._local_dir) if self._local_dir is not None else None,
                token=self._auth.token,
                endpoint=self._endpoint,
                allow_patterns=list(include_patterns) if include_patterns else None,
                ignore_patterns=list(exclude_patterns) if exclude_patterns else None,
                dry_run=True,
            )
        except HUB_ERROR_TYPES as error:
            raise normalize_hub_error(
                error, authenticated=self._auth.authenticated
            ) from error
        files = tuple(
            PlannedFile(
                path=entry.filename,
                size_bytes=entry.file_size,
                cached=entry.is_cached,
                will_download=entry.will_download,
            )
            for entry in results
        )
        commit = results[0].commit_hash if results else revision
        return SnapshotEstimate(resolved_commit=commit, files=files)

    def _repo_type(self, kind: RepositoryKind) -> HubRepoType:
        """Map a typed repository kind to the Hub ``repo_type`` string."""
        match kind:
            case ModelRepository():
                return REPO_TYPE_MODEL
            case DatasetRepository():
                return REPO_TYPE_DATASET
            case SpaceRepository():
                return REPO_TYPE_SPACE
