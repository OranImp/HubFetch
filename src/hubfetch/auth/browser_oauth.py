"""Shared machine browser OAuth flow over the pinned Hub adapter.

Drives the Hub's RFC 8628 device flow end to end: request a device code, open
the verification URI, poll off the GUI thread through the pinned adapter, save
the resulting token through the Hub's official shared-machine ``login``, and
record only non-secret account metadata. Every side effect is an injected seam
-- device-code request, blocking poll, token save, account resolution, URI
opening, off-thread execution, clock, and backoff -- so tests run
deterministically and the flow module itself never imports Qt or performs I/O
on the caller's thread.

The GUI thread must invoke :meth:`BrowserOAuthFlow.await_authorization` from a
worker context; the injected runner guarantees the Hub's blocking poll executes
on a background thread.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from . import oauth_contract
from .flow_models import (
    HubAccountParseError,
    IllegalFlowTransitionError,
    OAuthAccount,
    OAuthState,
    PollResult,
    derive_account,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from .oauth_contract import DeviceCodeInfo, OAuthTokenResponse

__all__ = [
    "BrowserOAuthFlow",
    "HubAccountParseError",
    "IllegalFlowTransitionError",
    "OAuthAccount",
    "OAuthFlowSeams",
    "OAuthState",
    "PollResult",
    "derive_account",
]


def _default_resolve_account(access_token: str) -> OAuthAccount:
    """Resolve account metadata through the pinned official stored-token API."""
    return derive_account(access_token, oauth_contract.get_stored_tokens())


def _run_in_thread(job: Callable[[], PollResult]) -> PollResult:
    """Execute one blocking poll on a background thread and return its result.

    The pool is scoped to the single call so the worker thread cannot outlive
    the poll; unexpected exceptions from a job surface in the caller exactly
    once instead of being silently dropped by a fire-and-forget thread.
    """
    with ThreadPoolExecutor(
        max_workers=1, thread_name_prefix="hubfetch-oauth"
    ) as executor:
        return executor.submit(job).result()


def _default_backoff(device_info: DeviceCodeInfo) -> float:
    """Return the device-code poll interval as the pacing readout."""
    return float(device_info["interval"])


@dataclass(frozen=True, slots=True)
class OAuthFlowSeams:
    """Every injectable seam of one browser OAuth flow.

    The production defaults bind the pinned Hub adapter, a real background
    thread, the monotonic clock, and the device-code interval; tests substitute
    each seam with a deterministic double.
    """

    open_uri: Callable[[str], bool]
    request_code: oauth_contract.RequestDeviceCode = oauth_contract.request_device_code
    poll: oauth_contract.PollDeviceToken = oauth_contract.poll_device_token
    save_token: oauth_contract.SaveToken = oauth_contract.save_token
    resolve_account: Callable[[str], OAuthAccount] = _default_resolve_account
    run_off_thread: Callable[[Callable[[], PollResult]], PollResult] = _run_in_thread
    clock: Callable[[], float] = time.monotonic
    backoff: Callable[[DeviceCodeInfo], float] = _default_backoff


class BrowserOAuthFlow:
    """One device-authorization flow with typed outcomes and injected seams.

    The flow never re-implements the OAuth protocol; the pinned Hub primitives
    perform the actual device-code exchange and polling. The injected clock
    bounds the device-code deadline, and the injected backoff exposes the
    poll-pacing interval so the caller can schedule UI updates.
    """

    __slots__: Final = (
        "_account",
        "_backoff",
        "_cancelled",
        "_clock",
        "_deadline",
        "_device_info",
        "_open_uri",
        "_poll",
        "_poll_interval",
        "_request_code",
        "_resolve_account",
        "_run_off_thread",
        "_save_token",
        "_state",
    )

    _account: OAuthAccount | None
    _backoff: Callable[[DeviceCodeInfo], float]
    _cancelled: bool
    _clock: Callable[[], float]
    _deadline: float
    _device_info: DeviceCodeInfo | None
    _open_uri: Callable[[str], bool]
    _poll: oauth_contract.PollDeviceToken
    _poll_interval: float
    _request_code: oauth_contract.RequestDeviceCode
    _resolve_account: Callable[[str], OAuthAccount]
    _run_off_thread: Callable[[Callable[[], PollResult]], PollResult]
    _save_token: oauth_contract.SaveToken
    _state: OAuthState

    def __init__(self, *, seams: OAuthFlowSeams) -> None:
        """Bind the injected seams; the flow starts in ``STARTED``."""
        self._open_uri = seams.open_uri
        self._request_code = seams.request_code
        self._poll = seams.poll
        self._save_token = seams.save_token
        self._resolve_account = seams.resolve_account
        self._run_off_thread = seams.run_off_thread
        self._clock = seams.clock
        self._backoff = seams.backoff
        self._state = OAuthState.STARTED
        self._account = None
        self._cancelled = False
        self._device_info = None
        self._deadline = 0.0
        self._poll_interval = 0.0

    @property
    def state(self) -> OAuthState:
        """Return the current flow state."""
        return self._state

    @property
    def account(self) -> OAuthAccount | None:
        """Return the resolved account metadata once authorized."""
        return self._account

    @property
    def poll_interval(self) -> float:
        """Return the injected backoff's poll-pacing interval in seconds."""
        return self._poll_interval

    def start(self) -> OAuthState:
        """Request a device code, open the verification URI, enter pending.

        A failed URI open is a typed failure, never a silent pending state.
        """
        self._require_state(OAuthState.STARTED)
        try:
            device_info = self._request_code()
        except oauth_contract.OAuthAdapterUnavailableError:
            return self._settle(OAuthState.FAILED)
        self._device_info = device_info
        self._deadline = self._clock() + float(device_info["expires_in"])
        self._poll_interval = self._backoff(device_info)
        opened = self._open_uri(device_info["verification_uri_complete"])
        if not opened:
            return self._settle(OAuthState.FAILED)
        return self._settle(OAuthState.PENDING)

    def await_authorization(self) -> OAuthState:
        """Poll off the GUI thread until authorized, expired, denied, or failed.

        The blocking Hub poll runs through the injected off-thread runner; the
        injected clock bounds the device-code deadline and the injected backoff
        already exposed the pacing interval. A cancellation requested before or
        during the poll wins over the eventual poll outcome.
        """
        if self._cancelled:
            return self._settle(OAuthState.CANCELLED)
        self._require_state(OAuthState.PENDING)
        if self._clock() >= self._deadline:
            return self._settle(OAuthState.EXPIRED)
        result = self._run_off_thread(self._poll_once)
        if self._cancelled:
            return self._settle(OAuthState.CANCELLED)
        return self._settle(result.state, result.account)

    def cancel(self) -> OAuthState:
        """Request cancellation of a pending authorization.

        The poll outcome is discarded when a cancel is requested; the flow
        settles as ``CANCELLED`` and never persists an account.
        """
        if self._state in (OAuthState.STARTED, OAuthState.PENDING):
            self._cancelled = True
            return self._settle(OAuthState.CANCELLED)
        return self._state

    def _poll_once(self) -> PollResult:
        """Run one blocking poll to its terminal outcome (worker thread)."""
        if self._cancelled:
            return PollResult(OAuthState.CANCELLED)
        if self._clock() >= self._deadline:
            return PollResult(OAuthState.EXPIRED)
        if self._device_info is None:
            raise IllegalFlowTransitionError(reason="flow has no device code")
        try:
            response = self._poll(self._device_info, on_pending=self._on_pending)
        except oauth_contract.DeviceCodeError as error:
            return PollResult(
                self._outcome_for(oauth_contract.device_code_error_code(error))
            )
        except (
            oauth_contract.HfHubHTTPError,
            oauth_contract.OfflineModeIsEnabled,
            oauth_contract.OAuthAdapterUnavailableError,
        ) as error:
            del error
            return PollResult(OAuthState.FAILED)
        return PollResult(OAuthState.AUTHORIZED, self._authorize(response))

    def _authorize(self, response: OAuthTokenResponse) -> OAuthAccount:
        """Persist the token machine-shared and resolve non-secret metadata."""
        access_token = response.get("access_token")
        if access_token is None:
            raise HubAccountParseError(reason="token response lacks an access token")
        self._save_token(access_token)
        return self._resolve_account(access_token)

    def _on_pending(self) -> None:
        """Informational pending callback routed by the pinned poller."""
        self._state = OAuthState.PENDING

    def _outcome_for(self, error_code: str | None) -> OAuthState:
        """Map a Hub device-code error code to the typed flow outcome."""
        match error_code:
            case oauth_contract.OAuthErrorCode.EXPIRED_TOKEN:
                return OAuthState.EXPIRED
            case oauth_contract.OAuthErrorCode.ACCESS_DENIED:
                return OAuthState.DENIED
            case _:
                return OAuthState.FAILED

    def _require_state(self, expected: OAuthState) -> None:
        if self._state is not expected:
            raise IllegalFlowTransitionError(
                reason=f"flow is {self._state.value}, expected {expected.value}"
            )

    def _settle(
        self, state: OAuthState, account: OAuthAccount | None = None
    ) -> OAuthState:
        self._state = state
        if account is not None:
            self._account = account
        return state
