"""Given/When/Then tests for authentication orchestration.

The shared OAuth path is driven by a real ``BrowserOAuthFlow`` whose seams are
wire-level fakes; the manual-token path is driven through a fake credential
store implementing the Todo 8 port.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Final, final, override

import pytest

from hubfetch.auth import oauth_contract
from hubfetch.auth.auth_service import (
    AuthService,
    InvalidManualTokenError,
    SharedLoginNotAuthorizedError,
    SharedLoginResult,
)
from hubfetch.auth.browser_oauth import (
    BrowserOAuthFlow,
    OAuthAccount,
    OAuthFlowSeams,
    OAuthState,
    PollResult,
)
from hubfetch.auth.oauth_contract import (
    DeviceCodeInfo,
    OAuthAdapterUnavailableError,
    OAuthContractState,
    OAuthTokenResponse,
)
from hubfetch.credentials.models import BackendIdentity, CredentialAlias
from hubfetch.credentials.port import CredentialStore
from hubfetch.domain.task_spec import AuthSource
from hubfetch.i18n import MessageCatalog

if TYPE_CHECKING:
    from collections.abc import Callable

_MANUAL_TOKEN_BYTES: Final = "hf-manual-token-value"  # noqa: S105 - test fixture
_ALICE_TOKEN_NAME: Final = "oauth-alice"  # noqa: S105 - metadata label, not a secret
_ADAPTER_NAME: Final = "huggingface_hub browser OAuth adapter"


@final
class FakeCredentialStore(CredentialStore):
    """In-memory credential store recording every create/delete."""

    def __init__(self) -> None:
        self.created: list[str] = []
        self.deleted: list[str] = []
        self._tokens: dict[str, str] = {}
        self._counter = 0

    @override
    def create(self, *, token: str) -> CredentialAlias:
        self.created.append(token)
        self._counter += 1
        alias = CredentialAlias(f"hfc-{self._counter:032x}")
        self._tokens[alias] = token
        return alias

    @override
    def replace(self, alias: CredentialAlias, *, token: str) -> None:
        self._tokens[alias] = token

    @override
    def resolve(self, alias: CredentialAlias) -> str:
        return self._tokens[alias]

    @override
    def delete(self, alias: CredentialAlias) -> None:
        self.deleted.append(alias)
        del self._tokens[alias]

    @property
    @override
    def backend_identity(self) -> BackendIdentity:
        return BackendIdentity(module="tests.auth", class_name="FakeCredentialStore")


def _device_info() -> DeviceCodeInfo:
    return DeviceCodeInfo(
        device_code="dev-123",
        expires_in=900,
        interval=5,
        user_code="ABCD-EFGH",
        verification_uri="https://huggingface.co/device",
        verification_uri_complete="https://huggingface.co/device?code=ABCD",
    )


def _save_nowhere(token: str) -> None:
    del token


def _resolve_alice(token: str) -> OAuthAccount:
    del token
    return OAuthAccount(username="alice", token_name=_ALICE_TOKEN_NAME)


def _run_sync(job: Callable[[], PollResult]) -> PollResult:
    return job()


def _open_any(uri: str) -> bool:
    del uri
    return True


def _make_flow(
    *, await_outcome: OAuthState = OAuthState.AUTHORIZED
) -> BrowserOAuthFlow:
    """Build a real flow whose wire-level poll settles at ``await_outcome``."""

    def poll(
        device_info: DeviceCodeInfo,
        *,
        on_pending: Callable[[], None] | None = None,
    ) -> OAuthTokenResponse:
        del device_info, on_pending
        if await_outcome is OAuthState.DENIED:
            denied_error = oauth_contract.DeviceCodeError(
                "authorization denied", "access_denied"
            )
            raise denied_error
        if await_outcome is OAuthState.EXPIRED:
            expired_error = oauth_contract.DeviceCodeError(
                "device code expired", "expired_token"
            )
            raise expired_error
        return {"access_token": _MANUAL_TOKEN_BYTES, "expires_in": 3600}

    seams = OAuthFlowSeams(
        open_uri=_open_any,
        request_code=_device_info,
        poll=poll,
        save_token=_save_nowhere,
        resolve_account=_resolve_alice,
        run_off_thread=_run_sync,
        clock=time.monotonic,
    )
    return BrowserOAuthFlow(seams=seams)


class TestManualTokenPath:
    def test_manual_token_login_stores_through_credential_store(self) -> None:
        store = FakeCredentialStore()
        service = AuthService(credential_store=store)

        alias = service.manual_token_login(token=_MANUAL_TOKEN_BYTES)

        assert store.created == [_MANUAL_TOKEN_BYTES]
        assert alias.startswith("hfc-")

    @pytest.mark.parametrize("token", ["", "   ", " leading", "trailing "])
    def test_invalid_manual_tokens_are_rejected(self, token: str) -> None:
        service = AuthService(credential_store=FakeCredentialStore())

        with pytest.raises(InvalidManualTokenError):
            _ = service.manual_token_login(token=token)


class TestSharedLogin:
    def test_shared_login_is_shared_oauth_and_never_touches_store(self) -> None:
        store = FakeCredentialStore()
        service = AuthService(credential_store=store)

        result = service.shared_login(flow=_make_flow())

        assert isinstance(result, SharedLoginResult)
        assert result.account == OAuthAccount(
            username="alice", token_name=_ALICE_TOKEN_NAME
        )
        assert result.source is AuthSource.SHARED_OAUTH
        assert store.created == []

    def test_denied_shared_login_raises_typed_error(self) -> None:
        service = AuthService(credential_store=FakeCredentialStore())

        with pytest.raises(SharedLoginNotAuthorizedError):
            _ = service.shared_login(flow=_make_flow(await_outcome=OAuthState.DENIED))


class TestAdapterUnavailable:
    def test_drifted_contract_disables_shared_login(self) -> None:
        store = FakeCredentialStore()
        unavailable = OAuthContractState(available=False, reason="signature_drift")
        service = AuthService(credential_store=store, contract_state=unavailable)

        assert service.shared_oauth_available is False
        with pytest.raises(OAuthAdapterUnavailableError):
            _ = service.shared_login()

    def test_manual_token_path_remains_when_contract_unavailable(self) -> None:
        store = FakeCredentialStore()
        unavailable = OAuthContractState(available=False, reason="signature_drift")
        service = AuthService(credential_store=store, contract_state=unavailable)

        alias = service.manual_token_login(token=_MANUAL_TOKEN_BYTES)

        assert store.created == [_MANUAL_TOKEN_BYTES]
        assert alias.startswith("hfc-")

    def test_shared_oauth_diagnostic_is_localized(self) -> None:
        unavailable = OAuthContractState(available=False, reason="signature_drift")
        service = AuthService(
            credential_store=FakeCredentialStore(), contract_state=unavailable
        )

        diagnostic = service.shared_oauth_diagnostic()

        assert diagnostic is not None
        assert _ADAPTER_NAME in diagnostic
        assert diagnostic == MessageCatalog().format_message(
            "error.dependency", {"name": _ADAPTER_NAME}
        )

    def test_shared_oauth_available_by_default(self) -> None:
        service = AuthService(credential_store=FakeCredentialStore())

        assert service.shared_oauth_available is True
        assert service.shared_oauth_diagnostic() is None
