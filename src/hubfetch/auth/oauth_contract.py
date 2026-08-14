"""Pinned ``huggingface_hub==1.27.0`` browser OAuth compatibility adapter.

This module is the single owner of every Hub OAuth symbol the product imports.
The device-authorization request and polling primitives live in the private
module ``huggingface_hub.utils._oauth_device`` and are not public API; pinning
them here -- together with the official public ``login`` and ``get_stored_tokens``
token-save/account APIs -- keeps any upstream drift localized to this file. No
other module may import these Hub OAuth symbols.

The Hub ``whoami`` account API is intentionally not pinned: its annotation is
the untyped ``dict`` return, which the strict type gate (reportUnknown* /
reportAny at error) cannot consume. The product instead derives account
metadata from the fully typed official ``login`` and ``get_stored_tokens``
APIs, which validate and persist the token under ``oauth-<username>``.

When the pinned symbols are absent (import failure) or their signatures drift
against the exact shapes below, :func:`verify_contract` reports an unavailable
state. Callers then disable browser OAuth, surface a localized compatibility
diagnostic, and keep the HubFetch-only manual-token path available.
"""

from __future__ import annotations

import inspect
from typing import TYPE_CHECKING, Final

from .contract_types import (
    CallableSpec,
    DeviceCodeErrorLike,
    DeviceCodeInfo,
    FallbackDeviceCodeError,
    FallbackOAuthErrorCode,
    Login,
    OAuthAdapterUnavailableError,
    OAuthContractState,
    OAuthErrorCodeLike,
    OAuthTokenResponse,
    PollDeviceToken,
    RequestDeviceCode,
    SaveToken,
    StoredTokens,
)

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = [
    "EXPECTED_LOGIN",
    "EXPECTED_POLL_DEVICE_TOKEN",
    "EXPECTED_REQUEST_DEVICE_CODE",
    "EXPECTED_STORED_TOKENS",
    "CallableSpec",
    "DeviceCodeError",
    "DeviceCodeErrorLike",
    "DeviceCodeInfo",
    "HfHubHTTPError",
    "Login",
    "OAuthAdapterUnavailableError",
    "OAuthContractState",
    "OAuthErrorCode",
    "OAuthErrorCodeLike",
    "OAuthTokenResponse",
    "OfflineModeIsEnabled",
    "PollDeviceToken",
    "RequestDeviceCode",
    "SaveToken",
    "StoredTokens",
    "check_callable_signature",
    "device_code_error_code",
    "get_stored_tokens",
    "login",
    "poll_device_token",
    "request_device_code",
    "save_token",
    "verify_contract",
]


# Pre-declared hub symbols; the guarded import assigns the real pinned objects
# or leaves the degraded stubs in place.
request_device_code: RequestDeviceCode
poll_device_token: PollDeviceToken
login: Login
get_stored_tokens: StoredTokens
DeviceCodeError: type[BaseException]
OAuthErrorCode: type[OAuthErrorCodeLike]
HfHubHTTPError: type[BaseException]
OfflineModeIsEnabled: type[BaseException]

_hub_import_failure: str | None = None

try:
    from huggingface_hub import login as _hub_login
    from huggingface_hub.errors import (
        DeviceCodeError as _hub_DeviceCodeError,
    )
    from huggingface_hub.errors import (
        HfHubHTTPError as _hub_HfHubHTTPError,
    )
    from huggingface_hub.errors import (
        OAuthErrorCode as _hub_OAuthErrorCode,
    )
    from huggingface_hub.errors import (
        OfflineModeIsEnabled as _hub_OfflineModeIsEnabled,
    )
    from huggingface_hub.utils._auth import get_stored_tokens as _hub_stored_tokens
    from huggingface_hub.utils._oauth_device import (
        poll_device_token as _hub_poll_device_token,
    )
    from huggingface_hub.utils._oauth_device import (
        request_device_code as _hub_request_device_code,
    )

    request_device_code = _hub_request_device_code
    poll_device_token = _hub_poll_device_token
    login = _hub_login
    get_stored_tokens = _hub_stored_tokens
    DeviceCodeError = _hub_DeviceCodeError
    OAuthErrorCode = _hub_OAuthErrorCode
    HfHubHTTPError = _hub_HfHubHTTPError
    OfflineModeIsEnabled = _hub_OfflineModeIsEnabled
    _hub_import_failure = None
except ImportError as _error:  # pragma: no cover - pinned version always present
    _hub_import_failure = str(_error)

    def _request_device_code_stub() -> DeviceCodeInfo:
        raise OAuthAdapterUnavailableError

    def _poll_device_token_stub(
        device_info: DeviceCodeInfo,
        *,
        on_pending: Callable[[], None] | None = None,
    ) -> OAuthTokenResponse:
        del device_info, on_pending
        raise OAuthAdapterUnavailableError

    def _login_stub(token: str) -> None:
        del token
        raise OAuthAdapterUnavailableError

    def _stored_tokens_stub() -> dict[str, str]:
        raise OAuthAdapterUnavailableError

    request_device_code = _request_device_code_stub
    poll_device_token = _poll_device_token_stub
    login = _login_stub
    get_stored_tokens = _stored_tokens_stub
    DeviceCodeError = FallbackDeviceCodeError
    OAuthErrorCode = FallbackOAuthErrorCode
    HfHubHTTPError = Exception
    OfflineModeIsEnabled = Exception


def save_token(token: str) -> None:
    """Persist an OAuth token through the Hub's official shared-machine login.

    The token lands in the Hub's own token store (machine-shared) and never in
    HubFetch's credential store or SQLite. With the adapter unavailable this
    raises :class:`OAuthAdapterUnavailableError`.
    """
    login(token)


def device_code_error_code(error: BaseException) -> str | None:
    """Return the OAuth error code of a caught Hub device-code error.

    ``DeviceCodeError`` is exposed as ``type[BaseException]`` (so ``except``
    clauses stay valid); this helper narrows the caught instance to the typed
    ``DeviceCodeErrorLike`` shape to read ``error_code``.
    """
    if not isinstance(error, DeviceCodeErrorLike):
        return None
    return error.error_code


_POLL_TAIL: Final = "*, on_pending: collections.abc.Callable[[], None] | None = None)"
_LOGIN_TAIL: Final = "skip_if_logged_in: bool = True)"
EXPECTED_REQUEST_DEVICE_CODE: Final = CallableSpec("()")
EXPECTED_POLL_DEVICE_TOKEN: Final = CallableSpec(
    "(device_info: huggingface_hub.utils._oauth_device.DeviceCodeInfo, " + _POLL_TAIL
)
EXPECTED_LOGIN: Final = CallableSpec(
    "(token: str | None = None, *, add_to_git_credential: bool = False, " + _LOGIN_TAIL
)
EXPECTED_STORED_TOKENS: Final = CallableSpec("()")


def check_callable_signature(
    callable_: Callable[..., object], expected: CallableSpec
) -> str | None:
    """Return a drift reason when a callable differs from the pinned spec.

    The rendered parameter string (parameter names, kinds, annotations, and
    defaults) must match the pinned string exactly; a None return means the
    signature matches. Inspect can raise for builtins or wrapped C functions,
    which is reported as drift so the adapter degrades rather than guess.
    """
    try:
        signature = inspect.signature(callable_)
    except (TypeError, ValueError):
        return "signature_unavailable"
    rendered = str(signature).split(" -> ", maxsplit=1)[0]
    if rendered != expected.parameters:
        return "signature_drift"
    return None


def verify_contract(
    *,
    request_code: RequestDeviceCode | None = request_device_code,
    poll: PollDeviceToken | None = poll_device_token,
    login_fn: Login | None = login,
    stored_tokens: StoredTokens | None = get_stored_tokens,
) -> OAuthContractState:
    """Return whether the pinned Hub browser OAuth adapter is usable.

    The default arguments are the exposed pinned primitives. Passing ``None``
    simulates a missing Hub installation (reported as ``hub_import``); passing
    callables with drifted signatures reports ``signature_drift``. Both states
    leave the manual-token path intact.
    """
    if _hub_import_failure is not None:
        return OAuthContractState(available=False, reason="hub_import")
    if (
        request_code is None
        or poll is None
        or login_fn is None
        or stored_tokens is None
    ):
        return OAuthContractState(available=False, reason="hub_import")
    drift = (
        check_callable_signature(request_code, EXPECTED_REQUEST_DEVICE_CODE)
        or check_callable_signature(poll, EXPECTED_POLL_DEVICE_TOKEN)
        or check_callable_signature(login_fn, EXPECTED_LOGIN)
        or check_callable_signature(stored_tokens, EXPECTED_STORED_TOKENS)
    )
    if drift is not None:
        return OAuthContractState(available=False, reason="signature_drift")
    return OAuthContractState(available=True, reason="")
