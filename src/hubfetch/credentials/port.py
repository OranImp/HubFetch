"""Credential store port for app-managed tokens in a platform vault.

The port stores only the token behind an opaque alias; account and display
metadata never cross this boundary. Resolved tokens are returned in the
narrowest scope and must be registered with the redactor while in use.
"""

from __future__ import annotations

from abc import ABCMeta, abstractmethod
from dataclasses import dataclass
from typing import TYPE_CHECKING, override

if TYPE_CHECKING:
    from .models import BackendIdentity, CredentialAlias


@dataclass(frozen=True, slots=True)
class CredentialError(RuntimeError):
    """Base typed error for every credential store failure."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"credential error: {self.reason}"


@dataclass(frozen=True, slots=True)
class CredentialNotFoundError(CredentialError):
    """The requested alias has no stored credential in the vault."""

    @override
    def __str__(self) -> str:
        return f"credential not found: {self.reason}"


@dataclass(frozen=True, slots=True)
class CredentialBackendError(CredentialError):
    """The underlying vault backend failed a storage operation."""

    @override
    def __str__(self) -> str:
        return f"credential backend failure: {self.reason}"


@dataclass(frozen=True, slots=True)
class CredentialBackendRejectedError(CredentialError):
    """Startup fail-closed policy rejected the configured keyring backend."""

    @override
    def __str__(self) -> str:
        return f"credential backend rejected: {self.reason}"


class CredentialStore(metaclass=ABCMeta):
    """Port that stores app-managed tokens behind opaque aliases."""

    @abstractmethod
    def create(self, *, token: str) -> CredentialAlias:
        """Store a new token and return its fresh opaque alias."""

    @abstractmethod
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        """Overwrite the token stored behind an existing alias."""

    @abstractmethod
    def resolve(self, alias: CredentialAlias) -> str:
        """Return the token stored behind one alias."""

    @abstractmethod
    def delete(self, alias: CredentialAlias) -> None:
        """Remove the token stored behind one alias."""

    @property
    @abstractmethod
    def backend_identity(self) -> BackendIdentity:
        """Return the verified backend identity for diagnostics."""
