"""Typed models and account derivation for the shared browser OAuth flow.

Pure value models with no I/O and no Hub imports: the flow outcome states, the
non-secret account metadata, and the derivation of that metadata from the
official stored-token map.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from typing import TYPE_CHECKING, Final, override

if TYPE_CHECKING:
    from collections.abc import Mapping

__all__ = [
    "HubAccountParseError",
    "IllegalFlowTransitionError",
    "OAuthAccount",
    "OAuthState",
    "PollResult",
    "derive_account",
]


@unique
class OAuthState(StrEnum):
    """Closed outcome states of one shared browser OAuth flow.

    ``STARTED`` is the constructed-but-not-started state; ``PENDING`` is set
    once the verification URI is open and authorization is awaited; the rest
    are terminal outcomes. ``FAILED`` covers unexpected network and adapter
    failures that are neither expiry, denial, nor cancellation.
    """

    STARTED = "started"
    PENDING = "pending"
    AUTHORIZED = "authorized"
    EXPIRED = "expired"
    DENIED = "denied"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class OAuthAccount:
    """Non-secret machine-shared account metadata from one shared login.

    Never carries token bytes; only the account username and the token name
    under which the Hub's shared store persists the token.
    """

    username: str
    token_name: str


@dataclass(frozen=True, slots=True)
class PollResult:
    """Outcome of one authorization poll plus its account metadata."""

    state: OAuthState
    account: OAuthAccount | None = None


@dataclass(frozen=True, slots=True)
class HubAccountParseError(ValueError):
    """The account metadata could not be resolved into a valid account."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"hub account parse error: {self.reason}"


@dataclass(frozen=True, slots=True)
class IllegalFlowTransitionError(RuntimeError):
    """An operation was invoked in a flow state that forbids it."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"illegal flow transition: {self.reason}"


_OAUTH_PREFIX: Final = "oauth-"


def derive_account(access_token: str, stored: Mapping[str, str]) -> OAuthAccount:
    """Derive non-secret account metadata from the official stored-token map.

    ``login`` persists OAuth tokens under ``oauth-<username>`` (or the token's
    display name when the server provides one); the matching stored entry yields
    both the machine-shared token name and the account label.
    """
    token_name = next(
        (name for name, token in stored.items() if token == access_token),
        f"{_OAUTH_PREFIX}unknown",
    )
    return OAuthAccount(
        username=token_name.removeprefix(_OAUTH_PREFIX),
        token_name=token_name,
    )
