"""Auth management service seam and its runtime adapter.

The auth panel depends only on the :class:`AuthPanelService` protocol; the
:class:`RuntimeAuthPanelService` implements it over the Todo 9 ``AuthService``
(shared browser OAuth) and the Todo 8 credential store (HubFetch-only manual
tokens). A :class:`BrowserLoginTicket` carries only non-secret pending metadata
(user code, verification URI, expiry, poll interval) so the UI can render the
browser-code pending/expiry/cancel states without ever holding token bytes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol, runtime_checkable

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices

from hubfetch.auth import oauth_contract
from hubfetch.auth.browser_oauth import BrowserOAuthFlow, OAuthFlowSeams
from hubfetch.auth.flow_models import OAuthState
from hubfetch.credentials.port import CredentialNotFoundError

if TYPE_CHECKING:
    from hubfetch.auth.auth_service import AuthService
    from hubfetch.auth.browser_oauth import OAuthAccount
    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.credentials.port import CredentialStore


@dataclass(frozen=True, slots=True)
class BrowserLoginTicket:
    """Non-secret pending metadata of one shared browser login.

    Carries the device code the user types into the verification page, the
    verification URI, and the monotonic expiry deadline; it never carries token
    bytes.
    """

    user_code: str
    verification_uri: str
    expires_at: float
    poll_interval: float


@runtime_checkable
class AuthPanelService(Protocol):
    """The typed seam the auth panel drives for both auth paths."""

    def shared_oauth_available(self) -> bool:
        """Return whether shared browser OAuth can run on this machine."""
        ...

    def shared_oauth_diagnostic(self) -> str | None:
        """Return a localized compatibility diagnostic when unavailable."""
        ...

    def begin_browser_login(self) -> BrowserLoginTicket | None:
        """Start a browser-code flow and return its pending metadata."""
        ...

    def await_authorization(self) -> OAuthState:
        """Block until the browser login settles into a typed outcome."""
        ...

    def cancel_browser_login(self) -> None:
        """Request cancellation of the pending browser login."""
        ...

    def authorized_account(self) -> OAuthAccount | None:
        """Return the resolved shared account once authorized."""
        ...

    def add_manual_token(self, *, token: str) -> CredentialAlias:
        """Store one HubFetch-only token and return its opaque alias."""
        ...

    def replace_manual_token(self, alias: CredentialAlias, *, token: str) -> None:
        """Overwrite the token behind an existing alias."""
        ...

    def delete_credential(self, alias: CredentialAlias) -> None:
        """Delete one stored HubFetch-only token."""
        ...

    def alias_exists(self, alias: CredentialAlias) -> bool:
        """Return whether the alias still resolves to a stored token."""
        ...


class RuntimeAuthPanelService:
    """Production auth-panel seam over AuthService plus the credential store."""

    __slots__: Final = ("_auth_service", "_flow", "_store")

    _auth_service: AuthService
    _store: CredentialStore
    _flow: BrowserOAuthFlow | None

    def __init__(
        self, auth_service: AuthService, credential_store: CredentialStore
    ) -> None:
        """Bind the Todo 9 auth orchestration and the Todo 8 credential store."""
        self._auth_service = auth_service
        self._store = credential_store
        self._flow = None

    def shared_oauth_available(self) -> bool:
        """Delegate the adapter availability check to the auth service."""
        return self._auth_service.shared_oauth_available

    def shared_oauth_diagnostic(self) -> str | None:
        """Return the localized compatibility diagnostic, if any."""
        return self._auth_service.shared_oauth_diagnostic()

    def begin_browser_login(self) -> BrowserLoginTicket | None:
        """Start the shared flow and capture only non-secret pending metadata.

        The injected ``request_code`` seam records the device-code info the flow
        requests internally so the ticket can carry the user code, verification
        URI, and expiry to the UI; the token itself is never retained here.
        """
        if not self._auth_service.shared_oauth_available:
            return None
        captured: dict[str, oauth_contract.DeviceCodeInfo] = {}

        def request_code() -> oauth_contract.DeviceCodeInfo:
            info = oauth_contract.request_device_code()
            captured["info"] = info
            return info

        flow = BrowserOAuthFlow(
            seams=OAuthFlowSeams(
                open_uri=_open_verification_uri,
                request_code=request_code,
            )
        )
        started = flow.start()
        info = captured.get("info")
        if started is not OAuthState.PENDING or info is None:
            return None
        self._flow = flow
        return BrowserLoginTicket(
            user_code=info["user_code"],
            verification_uri=info["verification_uri_complete"],
            expires_at=time.monotonic() + float(info["expires_in"]),
            poll_interval=flow.poll_interval,
        )

    def await_authorization(self) -> OAuthState:
        """Run the blocking authorization poll to its typed outcome."""
        flow = self._flow
        if flow is None:
            return OAuthState.FAILED
        return flow.await_authorization()

    def cancel_browser_login(self) -> None:
        """Cancel the pending shared login, discarding its poll outcome."""
        flow = self._flow
        if flow is not None:
            _ = flow.cancel()

    def authorized_account(self) -> OAuthAccount | None:
        """Return the resolved shared account, if the flow authorized."""
        flow = self._flow
        return flow.account if flow is not None else None

    def add_manual_token(self, *, token: str) -> CredentialAlias:
        """Store one HubFetch-only manual token through the auth service."""
        return self._auth_service.manual_token_login(token=token)

    def replace_manual_token(self, alias: CredentialAlias, *, token: str) -> None:
        """Overwrite the token behind the existing alias through the store."""
        self._store.replace(alias, token=token)

    def delete_credential(self, alias: CredentialAlias) -> None:
        """Delete one stored HubFetch-only token through the store."""
        self._store.delete(alias)

    def alias_exists(self, alias: CredentialAlias) -> bool:
        """Return whether the alias still resolves to a stored token."""
        try:
            _ = self._store.resolve(alias)
        except CredentialNotFoundError:
            return False
        return True


def _open_verification_uri(uri: str) -> bool:
    """Open the verification URI through the desktop services seam."""
    return QDesktopServices.openUrl(QUrl(uri))


__all__ = [
    "AuthPanelService",
    "BrowserLoginTicket",
    "RuntimeAuthPanelService",
]
