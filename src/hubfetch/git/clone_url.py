"""Typed clone URL models for Hugging Face repository layouts.

HTTPS URLs are derived from a validated repository reference, so credentials
can never be embedded: the builder receives only an ``author/name`` id and a
closed repository kind. User-provided SSH transport is accepted only through
:func:`ssh_clone_url`, which rejects any URL carrying a password. This module
is the URL boundary: callers hand the cloner a ``value`` string produced here,
never a raw, unvalidated URL.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, override
from urllib.parse import quote, urlsplit

from hubfetch.domain.repository import (
    DatasetRepository,
    ModelRepository,
    RepositoryRef,
    SpaceRepository,
)

HF_HOST: Final = "huggingface.co"
"""Default Hub host used in derived HTTPS clone URLs."""


@dataclass(frozen=True, slots=True)
class CloneUrlError(ValueError):
    """A clone URL failed the strict boundary contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid clone url: {self.reason}"


def _repository_path(repo: RepositoryRef) -> str:
    """Return the Hub path segment for one repository reference."""
    match repo.kind:
        case ModelRepository():
            return repo.repo_id
        case DatasetRepository():
            return f"datasets/{repo.repo_id}"
        case SpaceRepository():
            return f"spaces/{repo.repo_id}"


@dataclass(frozen=True, slots=True)
class HttpsRepoUrl:
    """HTTPS clone URL for one Hugging Face repository.

    Built only from a repository reference, so the URL cannot carry userinfo,
    a token, or a query credential. ``quote`` keeps the validated
    ``author/name`` path literal while percent-encoding any character that is
    not safe in a URL path.
    """

    repo: RepositoryRef
    host: str = HF_HOST

    @property
    def value(self) -> str:
        """Return the fully derived HTTPS clone URL."""
        return f"https://{self.host}/{quote(_repository_path(self.repo))}"


@dataclass(frozen=True, slots=True)
class SshRepoUrl:
    """A user-provided SSH clone URL validated to carry no credential."""

    value: str


def https_clone_url(repo: RepositoryRef) -> HttpsRepoUrl:
    """Build the typed HTTPS clone URL for one repository reference."""
    return HttpsRepoUrl(repo=repo)


def _reject_whitespace_or_nul(raw: str) -> None:
    """Reject empty, whitespace-bearing, or NUL-bearing SSH URLs."""
    if not raw or raw != raw.strip():
        raise CloneUrlError(reason="SSH URL must be non-empty without whitespace")
    if any(character.isspace() for character in raw) or "\x00" in raw:
        raise CloneUrlError(reason="SSH URL must not contain whitespace or NUL")


def _scp_like_target(raw: str) -> str:
    """Return the ``host:path`` target of an scp-like URL after validating user."""
    userinfo, separator, target = raw.partition("@")
    if separator:
        if not userinfo:
            raise CloneUrlError(reason="SSH URL has an empty user")
        if ":" in userinfo:
            raise CloneUrlError(reason="SSH URL must not embed a password")
        if not target:
            raise CloneUrlError(reason="SSH URL has no host after the user")
        return target
    return raw


def _validate_scp_like_shape(target: str) -> None:
    """Reject scp-like targets that are not a ``host:path`` pair."""
    host, separator, path = target.partition(":")
    if not separator or not host or not path:
        raise CloneUrlError(reason="SSH URL must be ssh://host/path or user@host:path")


def ssh_clone_url(raw: str) -> SshRepoUrl:
    """Parse and validate one user-provided SSH clone URL.

    Accepts both the scp-like ``[user@]host:path`` form and the ``ssh://`` URI
    form. Rejects surrounding or embedded whitespace, empty targets, and any
    URL that embeds a password (``user:password@host``), because credentials
    must never travel inside a URL or a process argument.
    """
    _reject_whitespace_or_nul(raw)
    if raw.startswith("ssh://"):
        parsed = urlsplit(raw)
        if parsed.password is not None:
            raise CloneUrlError(reason="SSH URL must not embed a password")
        if parsed.hostname is None:
            raise CloneUrlError(reason="SSH URL requires a host")
        return SshRepoUrl(value=raw)
    _validate_scp_like_shape(_scp_like_target(raw))
    return SshRepoUrl(value=raw)
