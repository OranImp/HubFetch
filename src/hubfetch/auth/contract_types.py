"""Pure typed contract for the pinned Hub browser OAuth adapter.

Holds every shared type and value contract of the adapter with no
``huggingface_hub`` imports. The adapter module (``oauth_contract.py``) is the
single owner of all Hub imports and re-exposes these names through its public
surface; nothing else in the product imports the Hub's private OAuth modules.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Final, Literal, Protocol, TypedDict, runtime_checkable

__all__ = [
    "CallableSpec",
    "DeviceCodeErrorLike",
    "DeviceCodeInfo",
    "Login",
    "OAuthAdapterUnavailableError",
    "OAuthContractState",
    "OAuthErrorCodeLike",
    "OAuthTokenResponse",
    "PollDeviceToken",
    "RequestDeviceCode",
    "SaveToken",
    "StoredTokens",
]


class DeviceCodeInfo(TypedDict):
    """Device authorization response (RFC 8628) normalized by the Hub adapter.

    The shape mirrors ``huggingface_hub.utils._oauth_device.DeviceCodeInfo``;
    the contract test proves the pinned upstream type stays structurally
    identical to this declaration.
    """

    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    interval: int
    expires_in: int


class OAuthTokenResponse(TypedDict, total=False):
    """Token endpoint response; ``access_token`` is always present on success.

    The shape mirrors ``huggingface_hub.utils._oauth_device.OAuthTokenResponse``
    and is proven structurally identical by the contract test.
    """

    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str


@runtime_checkable
class RequestDeviceCode(Protocol):
    """Typed signature of the pinned device-code request primitive."""

    def __call__(self) -> DeviceCodeInfo:
        """Request a fresh device authorization response."""
        ...


@runtime_checkable
class PollDeviceToken(Protocol):
    """Typed signature of the pinned token-polling primitive."""

    def __call__(
        self,
        device_info: DeviceCodeInfo,
        *,
        on_pending: Callable[[], None] | None = None,
    ) -> OAuthTokenResponse:
        """Poll the token endpoint until the device authorizes or fails."""
        ...


@runtime_checkable
class Login(Protocol):
    """Typed signature of the official shared-machine ``login`` token API."""

    def __call__(self, token: str) -> None:
        """Validate and persist one access token as the machine login."""
        ...


StoredTokens = Callable[[], dict[str, str]]
"""Typed signature of the official ``get_stored_tokens`` account API."""

SaveToken = Callable[[str], None]
"""Narrow save seam the flow uses; the adapter wraps ``login`` with it."""


@runtime_checkable
class DeviceCodeErrorLike(Protocol):
    """Runtime-checkable instance shape of the Hub ``DeviceCodeError``."""

    error_code: str | None


class OAuthErrorCodeLike(Protocol):
    """Enum-member shape of the Hub OAuth error codes exposed by the contract.

    Each member is pinned to its exact ``Literal`` value so the protocol check
    matches the Hub's ``(str, Enum)`` members invariantly.
    """

    AUTHORIZATION_PENDING: Literal["authorization_pending"]
    SLOW_DOWN: Literal["slow_down"]
    EXPIRED_TOKEN: Literal["expired_token"]
    ACCESS_DENIED: Literal["access_denied"]
    INVALID_GRANT: Literal["invalid_grant"]


@dataclass(frozen=True, slots=True)
class CallableSpec:
    """The exact pinned parameter signature of one upstream callable.

    ``parameters`` is the ``str(inspect.signature(callable))`` output up to the
    `` -> `` return annotation, for example
    ``"(token: str | None = None, *, add_to_git_credential: bool = False)"``.
    Comparing the rendered parameter string pins parameter names, kinds, and
    defaults exactly while staying fully typed (inspect's ``Parameter.default``
    is annotated ``Any`` and cannot be read under the strict type gate).
    """

    parameters: str


@dataclass(frozen=True, slots=True)
class OAuthContractState:
    """Availability of the pinned Hub browser OAuth adapter."""

    available: bool
    reason: str

    @property
    def unavailable_reason(self) -> str | None:
        """Return the stable machine reason when unavailable, else None."""
        return None if self.available else self.reason


class OAuthAdapterUnavailableError(RuntimeError):
    """Raised when a pinned Hub OAuth primitive is called while unavailable."""

    _MESSAGE: Final = "pinned Hub OAuth adapter unavailable"

    def __init__(self) -> None:
        """Raise with the stable, secret-free adapter-unavailable message."""
        super().__init__(self._MESSAGE)


class FallbackOAuthErrorCode(StrEnum):
    """Degraded stand-in matching the Hub's OAuth error-code enum shape."""

    AUTHORIZATION_PENDING = "authorization_pending"
    SLOW_DOWN = "slow_down"
    EXPIRED_TOKEN = "expired_token"  # noqa: S105 - enum tag, not a credential
    ACCESS_DENIED = "access_denied"
    INVALID_GRANT = "invalid_grant"


class FallbackDeviceCodeError(Exception):
    """Degraded stand-in matching the Hub's ``DeviceCodeError`` shape."""

    error_code: str | None

    def __init__(self, message: str, error_code: str | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code
