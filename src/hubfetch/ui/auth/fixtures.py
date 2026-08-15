"""Deterministic auth-state fixtures for the capture matrix.

The capture harness drives the :class:`AuthPanel` through every ownership and
browser-code state; this module owns the canned service seam and the per-state
panel builder so the matrix/render modules stay small. No token bytes exist in
these fixtures; the alias and account metadata are non-secret display values.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, override

from hubfetch.auth.browser_oauth import OAuthAccount
from hubfetch.auth.flow_models import OAuthState
from hubfetch.credentials.models import CredentialAlias
from hubfetch.i18n.catalog import MessageCatalog

from .dispatch import CapturingWorkDispatcher, SynchronousWorkDispatcher
from .panel import AuthPanel
from .service import AuthPanelService, BrowserLoginTicket

if TYPE_CHECKING:
    from hubfetch.ui.auth.texts import AuthTexts

__all__ = ["FakeAuthService", "build_state_panel", "states"]

ALIAS: Final = CredentialAlias("hfc-0123456789abcdef0123456789abcdef")
ACCOUNT: Final = OAuthAccount(
    username="alice",
    token_name="oauth-alice",  # noqa: S106 - display name, not a secret
)
PENDING_TICKET: Final = BrowserLoginTicket(
    user_code="ABCD-EFGH",
    verification_uri="https://huggingface.co/device?code=ABCD-EFGH",
    expires_at=999_999.0,
    poll_interval=5.0,
)

states: Final[tuple[str, ...]] = (
    "anonymous",
    "hubfetch_only",
    "shared",
    "pending",
    "expired",
    "denied",
    "cancelled",
    "unavailable",
    "token_entry",
    "confirm_delete",
)


class FakeAuthService(AuthPanelService):
    """Deterministic service seam driving every auth state for capture."""

    __slots__: Final = ("await_outcome", "shared_available")

    await_outcome: OAuthState
    shared_available: bool

    def __init__(
        self,
        *,
        await_outcome: OAuthState = OAuthState.AUTHORIZED,
        shared_available: bool = True,
    ) -> None:
        """Bind the canned outcome and adapter availability."""
        self.await_outcome = await_outcome
        self.shared_available = shared_available

    @override
    def shared_oauth_available(self) -> bool:
        """Return the canned adapter availability."""
        return self.shared_available

    @override
    def shared_oauth_diagnostic(self) -> str | None:
        """Return a localized diagnostic when the adapter is unavailable."""
        if self.shared_available:
            return None
        return MessageCatalog().format_message(
            "error.dependency",
            {"name": "huggingface_hub browser OAuth adapter"},
        )

    @override
    def begin_browser_login(self) -> BrowserLoginTicket | None:
        """Return the pending ticket with a stable future expiry."""
        if not self.shared_available:
            return None
        return PENDING_TICKET

    @override
    def await_authorization(self) -> OAuthState:
        """Return the canned outcome."""
        return self.await_outcome

    @override
    def cancel_browser_login(self) -> None:
        """No-op for the deterministic capture harness."""

    @override
    def authorized_account(self) -> OAuthAccount | None:
        """Return the shared account when the outcome authorized."""
        if self.await_outcome is not OAuthState.AUTHORIZED:
            return None
        return ACCOUNT

    @override
    def add_manual_token(self, *, token: str) -> CredentialAlias:
        """Return the opaque alias for the captured entry."""
        del token
        return ALIAS

    @override
    def replace_manual_token(self, alias: CredentialAlias, *, token: str) -> None:
        """No-op for the deterministic capture harness."""
        del alias, token

    @override
    def delete_credential(self, alias: CredentialAlias) -> None:
        """No-op for the deterministic capture harness."""
        del alias

    @override
    def alias_exists(self, alias: CredentialAlias) -> bool:
        """Return whether the alias is the captured one."""
        return alias == ALIAS


def build_state_panel(state: str, texts: AuthTexts) -> AuthPanel:
    """Compose an auth panel configured to render one locked state."""
    panel = _panel_for_state(state, texts)
    if state == "token_entry":
        panel.open_token_entry()
    elif state == "confirm_delete":
        panel.request_delete()
    elif state in _BROWSER_OUTCOMES or state == "unavailable":
        panel.sign_in_browser()
    return panel


_BROWSER_OUTCOMES: Final[dict[str, OAuthState]] = {
    "pending": OAuthState.AUTHORIZED,
    "expired": OAuthState.EXPIRED,
    "denied": OAuthState.DENIED,
    "cancelled": OAuthState.CANCELLED,
}

# Pending stays pending (CapturingWorkDispatcher holds the await); the
# terminal outcomes settle synchronously so their message renders.
_BROWSER_DISPATCHERS: Final[
    dict[str, type[SynchronousWorkDispatcher | CapturingWorkDispatcher]]
] = {
    "pending": CapturingWorkDispatcher,
    "expired": SynchronousWorkDispatcher,
    "denied": SynchronousWorkDispatcher,
    "cancelled": SynchronousWorkDispatcher,
}


def _panel_for_state(state: str, texts: AuthTexts) -> AuthPanel:
    """Build the auth panel in the requested locked configuration."""
    if state == "hubfetch_only":
        return AuthPanel(texts, FakeAuthService(), alias=ALIAS)
    if state == "shared":
        return AuthPanel(texts, FakeAuthService(), shared_account=ACCOUNT)
    if state == "unavailable":
        return AuthPanel(texts, FakeAuthService(shared_available=False))
    outcome = _BROWSER_OUTCOMES.get(state)
    if outcome is not None:
        dispatcher_cls = _BROWSER_DISPATCHERS.get(state, SynchronousWorkDispatcher)
        return AuthPanel(
            texts,
            FakeAuthService(await_outcome=outcome),
            dispatcher=dispatcher_cls(),
        )
    return AuthPanel(texts, FakeAuthService())
