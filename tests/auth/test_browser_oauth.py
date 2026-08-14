"""Given/When/Then tests for the shared browser OAuth flow.

Every external side effect is an injected seam: the tests substitute a wire-level
fake poll that drives the device-authorization pending-to-authorized sequence
without touching the network, and a fake clock that bounds the deadline.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

import pytest

from hubfetch.auth import oauth_contract
from hubfetch.auth.browser_oauth import (
    BrowserOAuthFlow,
    IllegalFlowTransitionError,
    OAuthAccount,
    OAuthFlowSeams,
    OAuthState,
    PollResult,
    derive_account,
)
from hubfetch.auth.oauth_contract import DeviceCodeInfo, OAuthTokenResponse

if TYPE_CHECKING:
    from collections.abc import Callable

_ACCESS_TOKEN_BYTES: Final = "hf-test-access-token-value"  # noqa: S105 - test fixture
_ALICE_TOKEN_NAME: Final = "oauth-alice"  # noqa: S105 - metadata label, not a secret
_UNKNOWN_TOKEN_NAME: Final = "oauth-unknown"  # noqa: S105 - metadata label
_VERIFICATION_URI: Final = "https://huggingface.co/device?user_code=ABCD-EFGH"


@final
class _FakeClock:
    """Deterministic monotonic clock for deadline and expiry tests."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def now(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


@final
class _Harness:
    """Wire-level fake over every injectable flow seam."""

    def __init__(self, *, open_uri_result: bool = True) -> None:
        self.clock = _FakeClock()
        self.opened: list[str] = []
        self.saved: list[str] = []
        self.resolved: list[str] = []
        self.poll_called: list[DeviceCodeInfo] = []
        self.poll_error: BaseException | None = None
        self.poll_result: OAuthTokenResponse = {
            "access_token": _ACCESS_TOKEN_BYTES,
            "expires_in": 3600,
        }
        self.account = OAuthAccount(username="alice", token_name=_ALICE_TOKEN_NAME)
        self.open_uri_result = open_uri_result

    def device_info(self) -> DeviceCodeInfo:
        return DeviceCodeInfo(
            device_code="dev-123",
            expires_in=900,
            interval=5,
            user_code="ABCD-EFGH",
            verification_uri="https://huggingface.co/device",
            verification_uri_complete=_VERIFICATION_URI,
        )

    def flow(self) -> BrowserOAuthFlow:
        seams = OAuthFlowSeams(
            open_uri=self.record_open,
            request_code=self.provide_device,
            poll=self.poll,
            save_token=self.save,
            resolve_account=self.resolve_account,
            run_off_thread=self.run_sync,
            clock=self.clock.now,
            backoff=lambda device_info: float(device_info["interval"]),
        )
        return BrowserOAuthFlow(seams=seams)

    def record_open(self, uri: str) -> bool:
        self.opened.append(uri)
        return self.open_uri_result

    def provide_device(self) -> DeviceCodeInfo:
        return self.device_info()

    def poll(
        self,
        device_info: DeviceCodeInfo,
        *,
        on_pending: Callable[[], None] | None = None,
    ) -> OAuthTokenResponse:
        del on_pending
        self.poll_called.append(device_info)
        if self.poll_error is not None:
            raise self.poll_error
        return self.poll_result

    def save(self, token: str) -> None:
        self.saved.append(token)

    def resolve_account(self, token: str) -> OAuthAccount:
        self.resolved.append(token)
        return self.account

    def run_sync(self, job: Callable[[], PollResult]) -> PollResult:
        return job()


class TestPendingToAuthorized:
    def test_pending_flow_authorizes_with_injected_clock(self) -> None:
        harness = _Harness()
        flow = harness.flow()

        started = flow.start()
        outcome = flow.await_authorization()

        assert started is OAuthState.PENDING
        assert outcome is OAuthState.AUTHORIZED
        assert flow.state is OAuthState.AUTHORIZED
        assert harness.opened == [_VERIFICATION_URI]
        assert harness.saved == [_ACCESS_TOKEN_BYTES]
        assert harness.resolved == [_ACCESS_TOKEN_BYTES]
        assert flow.account == OAuthAccount(
            username="alice", token_name=_ALICE_TOKEN_NAME
        )

    def test_poll_interval_exposes_injected_backoff(self) -> None:
        harness = _Harness()
        flow = harness.flow()

        _ = flow.start()

        assert flow.poll_interval == 5.0

    def test_authorized_account_carries_metadata_only(self) -> None:
        harness = _Harness()
        flow = harness.flow()
        _ = flow.start()
        _ = flow.await_authorization()

        account = flow.account
        assert account is not None
        assert account.username == "alice"
        assert account.token_name == _ALICE_TOKEN_NAME
        assert "token" not in (account.username, account.token_name)
        assert "hf-test-access-token-value" not in (
            account.username,
            account.token_name,
        )


class TestTerminalFailures:
    def test_denied_poll_settles_denied(self) -> None:
        harness = _Harness()
        harness.poll_error = oauth_contract.DeviceCodeError(
            "authorization denied", "access_denied"
        )
        flow = harness.flow()
        _ = flow.start()

        outcome = flow.await_authorization()

        assert outcome is OAuthState.DENIED
        assert flow.account is None

    def test_expired_device_code_settles_expired(self) -> None:
        harness = _Harness()
        harness.poll_error = oauth_contract.DeviceCodeError(
            "device code expired", "expired_token"
        )
        flow = harness.flow()
        _ = flow.start()

        outcome = flow.await_authorization()

        assert outcome is OAuthState.EXPIRED

    def test_unexpected_hub_error_settles_failed(self) -> None:
        harness = _Harness()
        harness.poll_error = oauth_contract.OfflineModeIsEnabled("offline")
        flow = harness.flow()
        _ = flow.start()

        outcome = flow.await_authorization()

        assert outcome is OAuthState.FAILED


class TestExpiryAndCancel:
    def test_expiry_before_poll_prevents_polling(self) -> None:
        harness = _Harness()
        flow = harness.flow()
        _ = flow.start()
        harness.clock.advance(901.0)

        outcome = flow.await_authorization()

        assert outcome is OAuthState.EXPIRED
        assert harness.poll_called == []

    def test_cancel_before_await_wins_over_poll(self) -> None:
        harness = _Harness()
        flow = harness.flow()
        _ = flow.start()

        cancelled = flow.cancel()
        outcome = flow.await_authorization()

        assert cancelled is OAuthState.CANCELLED
        assert outcome is OAuthState.CANCELLED
        assert harness.poll_called == []
        assert flow.account is None

    def test_cancel_after_terminal_state_is_idempotent(self) -> None:
        harness = _Harness()
        flow = harness.flow()
        _ = flow.start()
        _ = flow.await_authorization()

        cancelled = flow.cancel()

        assert cancelled is OAuthState.AUTHORIZED


class TestUrlOpeningSeam:
    def test_failed_uri_open_settles_failed(self) -> None:
        harness = _Harness(open_uri_result=False)
        flow = harness.flow()

        outcome = flow.start()

        assert outcome is OAuthState.FAILED
        assert flow.state is OAuthState.FAILED


class TestAdapterUnavailable:
    def test_unavailable_device_code_degrades_to_failed(self) -> None:
        harness = _Harness()

        def unavailable() -> DeviceCodeInfo:
            raise oauth_contract.OAuthAdapterUnavailableError

        seams = OAuthFlowSeams(open_uri=harness.record_open, request_code=unavailable)
        flow = BrowserOAuthFlow(seams=seams)

        outcome = flow.start()

        assert outcome is OAuthState.FAILED

    def test_unavailable_poll_degrades_to_failed(self) -> None:
        harness = _Harness()
        harness.poll_error = oauth_contract.OAuthAdapterUnavailableError()
        flow = harness.flow()
        _ = flow.start()

        outcome = flow.await_authorization()

        assert outcome is OAuthState.FAILED


class TestIllegalTransitions:
    def test_await_before_start_raises(self) -> None:
        flow = _Harness().flow()

        with pytest.raises(IllegalFlowTransitionError):
            _ = flow.await_authorization()

    def test_double_start_raises(self) -> None:
        flow = _Harness().flow()
        _ = flow.start()

        with pytest.raises(IllegalFlowTransitionError):
            _ = flow.start()


class TestDeriveAccount:
    def test_derives_account_from_matching_stored_entry(self) -> None:
        stored = {"oauth-alice": "tok1", "other-name": "tok2"}

        account = derive_account("tok1", stored)

        assert account == OAuthAccount(username="alice", token_name=_ALICE_TOKEN_NAME)

    def test_falls_back_when_token_not_in_stored_map(self) -> None:
        account = derive_account("missing", {})

        assert account == OAuthAccount(
            username="unknown", token_name=_UNKNOWN_TOKEN_NAME
        )
