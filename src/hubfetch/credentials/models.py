"""Typed, secret-free models for HubFetch app-managed credentials.

Only the opaque alias is ever handed to the vault; account and display
metadata travel through the persistence layer and never carry token bytes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, NewType, override
from uuid import uuid4

CredentialAlias = NewType("CredentialAlias", str)
"""Opaque handle to one stored credential; never a guessable account name."""

CredentialAccount = NewType("CredentialAccount", str)
"""Hugging Face account name shown to the user, never a token."""

_ALIAS_PREFIX: Final = "hfc"
_ALIAS_SEPARATOR: Final = "-"
_ALIAS_PATTERN: Final = re.compile(r"\Ahfc-[0-9a-f]{32}\Z")
"""Format of generated aliases: ``hfc-<32 hex chars>``, guaranteed opaque."""


@dataclass(frozen=True, slots=True)
class InvalidCredentialAliasError(ValueError):
    """An alias failed the opaque boundary format contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid credential alias: {self.reason}"


def generate_credential_alias() -> CredentialAlias:
    """Return a fresh opaque alias that never appears in product surfaces."""
    return CredentialAlias(f"{_ALIAS_PREFIX}{_ALIAS_SEPARATOR}{uuid4().hex}")


def parse_credential_alias(raw: str) -> CredentialAlias:
    """Parse an opaque alias at a raw boundary, rejecting anything else."""
    if _ALIAS_PATTERN.fullmatch(raw) is None:
        raise InvalidCredentialAliasError(reason=f"{raw!r} is not an opaque alias")
    return CredentialAlias(raw)


@dataclass(frozen=True, slots=True)
class CredentialDisplay:
    """Non-secret display metadata persisted outside the credential vault."""

    account: CredentialAccount
    label: str


@dataclass(frozen=True, slots=True)
class BackendIdentity:
    """Module and class identity of the verified credential backend."""

    module: str
    class_name: str
