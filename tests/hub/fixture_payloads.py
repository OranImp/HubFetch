"""JSON payload shapes and error specs for the Hub wire fixture.

This module holds the pure data contract of the Hub-compatible fixture: the
exact JSON a repo-info endpoint must return for each repository type, the
routing tables, and the wire failure specs (status plus ``X-Error-Code`` /
``X-Error-Message`` headers) the library's ``hf_raise_for_status`` turns into
its typed exceptions. Keeping these separate from the HTTP handler lets both
be reasoned about and reviewed independently.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, Literal

if TYPE_CHECKING:
    from collections.abc import Sequence

DEFAULT_COMMIT: Final = "a" * 40
DEFAULT_ETAG: Final = '"fixture-etag-0001"'
DEFAULT_REVISION_NAME: Final = "main"

RepoType = Literal["model", "dataset", "space"]
FixtureError = Literal[
    "none",
    "repo_not_found",
    "revision_not_found",
    "gated",
    "disabled",
    "unauthorized",
    "invalid_credentials",
    "rate_limit",
    "server_error",
]

PLURAL: Final[dict[RepoType, str]] = {
    "model": "models",
    "dataset": "datasets",
    "space": "spaces",
}
RESOLVE_PREFIX: Final[dict[RepoType, str]] = {
    "model": "",
    "dataset": "datasets/",
    "space": "spaces/",
}

_MODEL_REQUIRED: Final = (
    "id",
    "author",
    "base_models",
    "card_data",
    "children_model_count",
    "config",
    "created_at",
    "disabled",
    "downloads",
    "downloads_all_time",
    "eval_results",
    "gated",
    "gguf",
    "inference",
    "inference_provider_mapping",
    "last_modified",
    "library_name",
    "likes",
    "mask_token",
    "model_index",
    "pipeline_tag",
    "private",
    "resource_group",
    "safetensors",
    "security_repo_status",
    "sha",
    "siblings",
    "spaces",
    "tags",
    "transformers_info",
    "trending_score",
    "used_storage",
    "widget_data",
)
_DATASET_REQUIRED: Final = (
    "id",
    "author",
    "card_data",
    "citation",
    "created_at",
    "description",
    "disabled",
    "downloads",
    "downloads_all_time",
    "gated",
    "last_modified",
    "likes",
    "main_size",
    "paperswithcode_id",
    "private",
    "resource_group",
    "sha",
    "siblings",
    "tags",
    "trending_score",
    "used_storage",
)
_SPACE_REQUIRED: Final = (
    "id",
    "author",
    "card_data",
    "created_at",
    "datasets",
    "disabled",
    "gated",
    "host",
    "last_modified",
    "likes",
    "models",
    "private",
    "region",
    "resource_group",
    "runtime",
    "sdk",
    "sha",
    "siblings",
    "subdomain",
    "tags",
    "trending_score",
    "used_storage",
)
_REQUIRED_BY_TYPE: Final[dict[RepoType, tuple[str, ...]]] = {
    "model": _MODEL_REQUIRED,
    "dataset": _DATASET_REQUIRED,
    "space": _SPACE_REQUIRED,
}

FailureSpec = tuple[int, str | None, str | None]
"""A fixture failure as ``(status, X-Error-Code, X-Error-Message)``."""

ERROR_SPEC: Final[dict[FixtureError, FailureSpec]] = {
    "repo_not_found": (404, "RepoNotFound", None),
    "gated": (403, "GatedRepo", None),
    "disabled": (403, None, "Access to this resource is disabled."),
    "unauthorized": (401, "RepoNotFound", None),
    "invalid_credentials": (401, None, "Invalid credentials in Authorization header"),
    "rate_limit": (429, None, None),
    "server_error": (500, None, None),
    "revision_not_found": (404, "RevisionNotFound", None),
}


def failure_spec(error: FixtureError) -> FailureSpec | None:
    """Return the wire failure for one fixture error tag, or None for success."""
    return ERROR_SPEC.get(error)


def repo_info_payload(  # noqa: PLR0913 - mirrors the Hub API's own field set
    repo_type: RepoType,
    repo_id: str,
    commit: str,
    files: Sequence[tuple[str, int]],
    *,
    gated: bool,
    private: bool,
) -> dict[str, object]:
    """Build the exact JSON a Hub repo-info endpoint returns."""
    payload: dict[str, object] = {
        "id": repo_id,
        "author": repo_id.split("/", maxsplit=1)[0],
        "sha": commit,
        "gated": gated,
        "private": private,
        "disabled": False,
        "tags": [],
        "siblings": [
            {"rfilename": path, "size": size, "blobId": f"{index:040x}"}
            for index, (path, size) in enumerate(files, start=1)
        ],
    }
    for name in _REQUIRED_BY_TYPE[repo_type]:
        _ = payload.setdefault(name, None)
    return payload
