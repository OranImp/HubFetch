"""Strict tagged models for Hugging Face repository kinds and references.

The repository kind is a Pydantic discriminated union over the three Hub
repository families (model, dataset, Space) so an unknown kind tag is a
parse failure rather than an open string. ``RepositoryRef`` is the frozen
wire shape carried by every download and clone specification.
"""

from dataclasses import dataclass
from typing import Annotated, ClassVar, Final, Literal, override

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .ids import RepositoryId

REPO_ID_PART_COUNT: Final = 2


class StrictModel(BaseModel):
    """Frozen boundary model that rejects unknown fields and stores no secrets."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)


@dataclass(frozen=True, slots=True)
class RepositoryRefError(ValueError):
    """A repository reference failed the Hub boundary format contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid repository reference: {self.reason}"


class ModelRepository(StrictModel):
    """A model repository on the Hugging Face Hub."""

    kind: Literal["model"] = "model"


class DatasetRepository(StrictModel):
    """A dataset repository on the Hugging Face Hub."""

    kind: Literal["dataset"] = "dataset"


class SpaceRepository(StrictModel):
    """A Space repository on the Hugging Face Hub."""

    kind: Literal["space"] = "space"


RepositoryKind = Annotated[
    ModelRepository | DatasetRepository | SpaceRepository,
    Field(discriminator="kind"),
]


def _validate_repo_id(value: RepositoryId) -> RepositoryId:
    """Reject repo ids that cannot be an ``author/name`` pair."""
    parts = value.split("/")
    if len(parts) != REPO_ID_PART_COUNT or any(not part for part in parts):
        raise RepositoryRefError(reason="repo id must be author/name")
    if any("\x00" in part or " " in part for part in parts):
        raise RepositoryRefError(reason="repo id contains forbidden characters")
    return value


def _validate_revision(value: str | None) -> str | None:
    """Reject empty revisions while preserving the unset value."""
    if value is None:
        return None
    if not value or "\x00" in value:
        raise RepositoryRefError(reason="revision is empty or contains a NUL character")
    return value


class RepositoryRef(StrictModel):
    """One Hugging Face repository at an optional revision."""

    repo_id: RepositoryId
    kind: RepositoryKind
    revision: str | None = None

    @field_validator("repo_id")
    @classmethod
    def _check_repo_id(cls, value: RepositoryId) -> RepositoryId:
        return _validate_repo_id(value)

    @field_validator("revision")
    @classmethod
    def _check_revision(cls, value: str | None) -> str | None:
        return _validate_revision(value)
