"""Authentication orchestration: shared browser OAuth vs manual tokens.

The manual-token path writes through the Todo 8 credential store (Windows
Credential Manager behind an opaque alias). The shared OAuth path never touches
the credential store or SQLite: the token lives only in the Hub's own
machine-shared store, and HubFetch records non-secret account metadata. Shared
logins are always labeled ``AuthSource.SHARED_OAUTH`` and are never persisted
as HubFetch-only app credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, override

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices

from hubfetch.domain.task_spec import AuthSource
from hubfetch.i18n import MessageCatalog

from .browser_oauth import (
    BrowserOAuthFlow,
    OAuthAccount,
    OAuthFlowSeams,
    OAuthState,
)
from .oauth_contract import (
    OAuthAdapterUnavailableError,
    OAuthContractState,
    verify_contract,
)

if TYPE_CHECKING:
    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore

__all__ = [
    "AuthService",
    "InvalidManualTokenError",
    "SharedLoginNotAuthorizedError",
    "SharedLoginResult",
]


@dataclass(frozen=True, slots=True)
class SharedLoginResult:
    """Outcome of a completed shared machine browser OAuth login.

    The ``source`` is fixed to ``AuthSource.SHARED_OAUTH``; a shared login is
    never recorded as a HubFetch-only app token.
    """

    account: OAuthAccount
    source: AuthSource = AuthSource.SHARED_OAUTH


@dataclass(frozen=True, slots=True)
class SharedLoginNotAuthorizedError(RuntimeError):
    """The shared OAuth flow ended without an authorized account."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"shared login not authorized: {self.reason}"


@dataclass(frozen=True, slots=True)
class InvalidManualTokenError(ValueError):
    """A manual token failed the input boundary contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid manual token: {self.reason}"


_ADAPTER_DEPENDENCY_NAME: Final = "huggingface_hub browser OAuth adapter"


class AuthService:
    """Orchestrates the shared OAuth and HubFetch-only manual-token paths.

    A compatibility diagnostic is emitted through the Todo 6 catalog whenever
    the pinned Hub adapter is unavailable, while the manual-token path remains
    fully usable.
    """

    __slots__: Final = ("_catalog", "_contract", "_seams", "_store")

    _catalog: MessageCatalog
    _contract: OAuthContractState
    _seams: OAuthFlowSeams | None
    _store: CredentialStore

    def __init__(
        self,
        *,
        credential_store: CredentialStore,
        catalog: MessageCatalog | None = None,
        contract_state: OAuthContractState | None = None,
        seams: OAuthFlowSeams | None = None,
    ) -> None:
        """Bind the store, catalog, adapter contract, and optional flow seams."""
        self._store = credential_store
        self._catalog = catalog if catalog is not None else MessageCatalog()
        self._contract = (
            contract_state if contract_state is not None else verify_contract()
        )
        self._seams = seams

    @property
    def shared_oauth_available(self) -> bool:
        """Return whether shared browser OAuth can run on this machine."""
        return self._contract.available

    def shared_oauth_diagnostic(self) -> str | None:
        """Return a localized compatibility diagnostic when unavailable.

        The stable ``error.dependency`` message ID is rendered through the
        Todo 6 catalog with the adapter name as its literal parameter; None is
        returned while the adapter is available.
        """
        if self._contract.available:
            return None
        return self._catalog.format_message(
            "error.dependency", {"name": _ADAPTER_DEPENDENCY_NAME}
        )

    def shared_login(
        self, *, flow: BrowserOAuthFlow | None = None
    ) -> SharedLoginResult:
        """Run the shared machine browser OAuth flow to authorization.

        The token is persisted only through the Hub's official shared store;
        the credential store and SQLite are never touched. A cancelled,
        expired, denied, or failed outcome raises a typed error instead of
        returning an account.
        """
        if not self._contract.available:
            raise OAuthAdapterUnavailableError
        active = flow if flow is not None else self._build_flow()
        started = active.start()
        if started is not OAuthState.PENDING:
            raise SharedLoginNotAuthorizedError(
                reason=f"flow start ended with {started.value}"
            )
        outcome = active.await_authorization()
        if outcome is not OAuthState.AUTHORIZED:
            raise SharedLoginNotAuthorizedError(
                reason=f"shared login ended with {outcome.value}"
            )
        account = active.account
        if account is None:
            raise SharedLoginNotAuthorizedError(
                reason="authorized flow lacks account metadata"
            )
        return SharedLoginResult(account=account)

    def manual_token_login(self, *, token: str) -> CredentialAlias:
        """Store one HubFetch-only manual token and return its opaque alias.

        The token crosses the input boundary here: it must be non-empty and
        must not contain surrounding whitespace, which would indicate a paste
        error. The credential store performs the actual durable write.
        """
        if not token or token != token.strip():
            raise InvalidManualTokenError(
                reason="token must be non-empty without surrounding whitespace"
            )
        return self._store.create(token=token)

    def _build_flow(self) -> BrowserOAuthFlow:
        return BrowserOAuthFlow(
            seams=self._seams if self._seams is not None else _default_seams()
        )


def _default_seams() -> OAuthFlowSeams:
    """Build the production seams with Qt's desktop-services URL opener."""
    return OAuthFlowSeams(open_uri=lambda uri: QDesktopServices.openUrl(QUrl(uri)))
