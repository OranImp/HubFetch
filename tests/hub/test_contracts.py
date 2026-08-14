# pyright: reportUnknownVariableType = false
# pyright: reportUnknownMemberType = false
# pyright: reportUnknownArgumentType = false
# pyright: reportAny = false
"""Contract tests pinning the exact huggingface_hub 1.27.0 API surface.

Each test proves one shape of the pinned surface used by the Hub adapter:
version, download function parameters, repo-info methods, exception
hierarchy, dry-run payload, and the typed planning models defined in
``hubfetch.hub.contracts``. A signature drift in an upgrade fails here before
any adapter code runs.

The ``pyright`` directives mirror the ones in ``hubfetch.hub.adapter``: the
1.27.0 stubs type ``hf_hub_download`` and ``snapshot_download`` with unknown
tqdm parameters, and this test module exists precisely to introspect those
two callables. The ``reportAny`` directive covers ``Parameter.default`` from
the standard library stub.
"""

from __future__ import annotations

import dataclasses
import inspect
from typing import TYPE_CHECKING

import huggingface_hub
from huggingface_hub import DryRunFileInfo, HfApi, hf_hub_download, snapshot_download
from huggingface_hub import errors as hub_errors

if TYPE_CHECKING:
    from collections.abc import Callable

from hubfetch.hub.contracts import (
    DEFAULT_REVISION,
    FULL_COMMIT_HASH_LENGTH,
    PINNED_HUB_VERSION,
    REPO_TYPE_DATASET,
    REPO_TYPE_MODEL,
    REPO_TYPE_SPACE,
    HubFile,
    PlannedFile,
    RepositoryInspection,
    SingleFileEstimate,
    SnapshotEstimate,
)


def _parameter_names(callable_: Callable[..., object]) -> set[str]:
    """Return the parameter names of one callable's pinned signature."""
    return set(inspect.signature(callable_).parameters)


def _renders_default_false(callable_: Callable[..., object], name: str) -> bool:
    """Return whether one parameter renders with ``= False`` as its default."""
    return "= False" in str(inspect.signature(callable_).parameters[name])


class TestPinnedVersion:
    """Given the installed library, when reading its version, then it matches."""

    def test_version_is_pinned(self) -> None:
        assert huggingface_hub.__version__ == PINNED_HUB_VERSION


class TestDownloadContracts:
    """Given pinned download functions, when inspecting signatures, shapes match."""

    def test_hf_hub_download_supports_planning_parameters(self) -> None:
        parameters = _parameter_names(hf_hub_download)
        assert {"repo_id", "filename"} <= parameters
        for name in (
            "repo_type",
            "revision",
            "cache_dir",
            "local_dir",
            "force_download",
            "token",
            "local_files_only",
            "endpoint",
            "dry_run",
        ):
            assert name in parameters, f"hf_hub_download lost parameter {name!r}"

    def test_hf_hub_download_dry_run_defaults_to_false(self) -> None:
        assert _renders_default_false(hf_hub_download, "dry_run")

    def test_snapshot_download_supports_patterns_and_planning_parameters(self) -> None:
        parameters = _parameter_names(snapshot_download)
        for name in (
            "repo_id",
            "repo_type",
            "revision",
            "cache_dir",
            "local_dir",
            "force_download",
            "token",
            "local_files_only",
            "allow_patterns",
            "ignore_patterns",
            "max_workers",
            "endpoint",
            "dry_run",
        ):
            assert name in parameters, f"snapshot_download lost parameter {name!r}"

    def test_snapshot_download_dry_run_defaults_to_false(self) -> None:
        assert _renders_default_false(snapshot_download, "dry_run")


class TestRepoInfoContracts:
    """Given HfApi repo-info methods, when inspecting signatures, revisions resolve."""

    def test_repo_info_methods_exist_on_hf_api(self) -> None:
        for name in ("model_info", "dataset_info", "space_info"):
            assert callable(getattr(HfApi, name)), f"HfApi lost method {name!r}"

    def test_model_info_accepts_revision_and_token(self) -> None:
        parameters = _parameter_names(HfApi.model_info)
        assert {"repo_id", "revision", "token"} <= parameters

    def test_dataset_info_accepts_revision_and_token(self) -> None:
        parameters = _parameter_names(HfApi.dataset_info)
        assert {"repo_id", "revision", "token"} <= parameters

    def test_space_info_accepts_revision_and_token(self) -> None:
        parameters = _parameter_names(HfApi.space_info)
        assert {"repo_id", "revision", "token"} <= parameters


class TestDryRunPayloadContract:
    """Given the dry-run payload type, when inspecting fields, it is planning-shaped."""

    def test_dry_run_file_info_carries_planning_fields(self) -> None:
        names = {field.name for field in dataclasses.fields(DryRunFileInfo)}
        assert {
            "commit_hash",
            "file_size",
            "filename",
            "local_path",
            "is_cached",
            "will_download",
        } <= names


class TestExceptionHierarchy:
    """Given pinned exception classes, when inspecting hierarchy, then it is stable."""

    def test_gated_error_is_a_not_found_error(self) -> None:
        assert issubclass(hub_errors.GatedRepoError, hub_errors.RepositoryNotFoundError)

    def test_http_errors_share_the_hub_http_base(self) -> None:
        for name in (
            "RepositoryNotFoundError",
            "RevisionNotFoundError",
            "DisabledRepoError",
            "BadRequestError",
        ):
            assert issubclass(getattr(hub_errors, name), hub_errors.HfHubHTTPError), (
                f"{name} is not an HfHubHTTPError subclass"
            )

    def test_offline_error_is_a_connection_error(self) -> None:
        assert issubclass(hub_errors.OfflineModeIsEnabled, ConnectionError)

    def test_local_entry_not_found_is_a_file_not_found_error(self) -> None:
        assert issubclass(hub_errors.LocalEntryNotFoundError, FileNotFoundError)


class TestPinnedConstants:
    """Given the planning constants, when reading them, then they match the library."""

    def test_repo_type_strings(self) -> None:
        assert REPO_TYPE_MODEL == "model"
        assert REPO_TYPE_DATASET == "dataset"
        assert REPO_TYPE_SPACE == "space"

    def test_default_revision_is_main(self) -> None:
        assert DEFAULT_REVISION == "main"

    def test_full_commit_hash_is_40_hex(self) -> None:
        assert FULL_COMMIT_HASH_LENGTH == 40


class TestPlanningModels:
    """Given typed planning models, when inspecting them, they are frozen and shaped."""

    def test_hub_file_carries_path_and_size(self) -> None:
        names = {field.name for field in dataclasses.fields(HubFile)}
        assert {"path", "size_bytes"} <= names
        assert dataclasses.is_dataclass(HubFile)

    def test_planned_file_carries_cache_state(self) -> None:
        names = {field.name for field in dataclasses.fields(PlannedFile)}
        assert {"path", "size_bytes", "cached", "will_download"} <= names

    def test_repository_inspection_carries_commit_and_files(self) -> None:
        names = {field.name for field in dataclasses.fields(RepositoryInspection)}
        assert {"resolved_commit", "gated", "private", "files"} <= names

    def test_single_file_estimate_shapes_one_file(self) -> None:
        names = {field.name for field in dataclasses.fields(SingleFileEstimate)}
        assert {"resolved_commit", "file"} <= names

    def test_snapshot_estimate_shapes_many_files(self) -> None:
        names = {field.name for field in dataclasses.fields(SnapshotEstimate)}
        assert {"resolved_commit", "files"} <= names
