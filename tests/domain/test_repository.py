"""Tests for strict repository kind and reference contracts."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from hubfetch.domain.ids import RepositoryId
from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryRef,
    SpaceRepository,
)


def test_repository_kind_variants_round_trip_when_serialized() -> None:
    """Given every repository kind, JSON round-trip restores the exact kind."""
    for kind in (ModelRepository(), DatasetRepository(), SpaceRepository()):
        ref = RepositoryRef(repo_id=RepositoryId("org/demo"), kind=kind)

        restored = RepositoryRef.model_validate_json(ref.model_dump_json())

        assert restored.kind == kind
        assert restored.kind.kind == kind.kind


def test_repository_ref_rejects_malformed_repo_ids_when_parsed() -> None:
    """Given malformed repo ids, the repository reference rejects them."""
    for bad_repo_id in ("no-slash", "org/", "/name", "org/name/extra", "org name/x"):
        with pytest.raises(ValidationError):
            _ = RepositoryRef.model_validate(
                {"repo_id": bad_repo_id, "kind": {"kind": "model"}}
            )


def test_repository_ref_rejects_empty_revision_when_parsed() -> None:
    """Given an empty revision, the repository reference rejects it."""
    with pytest.raises(ValidationError):
        _ = RepositoryRef.model_validate(
            {"repo_id": "org/demo", "kind": {"kind": "model"}, "revision": ""}
        )


def test_repository_ref_accepts_named_revisions_when_parsed() -> None:
    """Given a branch or tag revision, the reference accepts it unchanged."""
    ref = RepositoryRef(
        repo_id=RepositoryId("org/demo"),
        kind=ModelRepository(),
        revision="main",
    )

    restored = RepositoryRef.model_validate_json(ref.model_dump_json())

    assert restored.revision == "main"
