"""Pure ownership semantics and localized label mapping for the auth panel.

The auth management surface distinguishes three closed ownership states --
anonymous, shared machine account, and HubFetch-only token. This module owns
the :class:`AuthOwnership` enum and every pure derivation/label function so the
widget keeps only Qt state and delegation; tests can assert the semantics
without constructing widgets.
"""

from __future__ import annotations

from enum import StrEnum, unique
from typing import TYPE_CHECKING

from hubfetch.auth.flow_models import OAuthState
from hubfetch.domain.task_spec import AuthSource

if TYPE_CHECKING:
    from hubfetch.auth.browser_oauth import OAuthAccount
    from hubfetch.credentials.models import CredentialAlias

    from .layout import PanelWidgets
    from .service import BrowserLoginTicket
    from .texts import AuthTexts

__all__ = [
    "AuthOwnership",
    "account_metadata",
    "auth_source_semantics",
    "browser_outcome_message",
    "derive_ownership",
    "flow_announcement",
    "ownership_label",
    "pending_summary",
    "render_status",
]


@unique
class AuthOwnership(StrEnum):
    """Closed ownership semantics of the current credential state."""

    ANONYMOUS = "anonymous"
    SHARED = "shared"
    HUBFETCH_ONLY = "hubfetch_only"


def derive_ownership(
    *,
    shared_account: OAuthAccount | None,
    alias: CredentialAlias | None,
) -> AuthOwnership:
    """Derive the closed ownership from the current credential state."""
    if shared_account is not None:
        return AuthOwnership.SHARED
    if alias is not None:
        return AuthOwnership.HUBFETCH_ONLY
    return AuthOwnership.ANONYMOUS


def ownership_label(texts: AuthTexts, ownership: AuthOwnership) -> str:
    """Return the localized ownership label for one ownership state."""
    match ownership:
        case AuthOwnership.SHARED:
            return texts.ownership_shared
        case AuthOwnership.HUBFETCH_ONLY:
            return texts.ownership_hubfetch
        case AuthOwnership.ANONYMOUS:
            return texts.ownership_anonymous


def account_metadata(
    texts: AuthTexts,
    ownership: AuthOwnership,
    *,
    shared_account: OAuthAccount | None,
    alias: CredentialAlias | None,
) -> str:
    """Return the non-secret account/alias metadata, or an empty string."""
    match ownership:
        case AuthOwnership.SHARED:
            account = shared_account
            if account is None:
                return ""
            return texts.metadata_shared_format.format(
                username=account.username, token_name=account.token_name
            )
        case AuthOwnership.HUBFETCH_ONLY:
            if alias is None:
                return ""
            return texts.metadata_hubfetch_format.format(alias=alias)
        case AuthOwnership.ANONYMOUS:
            return ""


def auth_source_semantics(ownership: AuthOwnership) -> AuthSource:
    """Return the task-spec auth-source semantics of one ownership state."""
    match ownership:
        case AuthOwnership.SHARED:
            return AuthSource.SHARED_OAUTH
        case AuthOwnership.HUBFETCH_ONLY:
            return AuthSource.MANUAL_TOKEN
        case AuthOwnership.ANONYMOUS:
            return AuthSource.ANONYMOUS


def browser_outcome_message(texts: AuthTexts, state: OAuthState) -> str | None:
    """Return the terminal browser-outcome message, if one is showing."""
    match state:
        case OAuthState.EXPIRED:
            return texts.expired_message
        case OAuthState.DENIED:
            return texts.denied_message
        case OAuthState.CANCELLED:
            return texts.cancelled_message
        case OAuthState.FAILED:
            return texts.failed_message
        case _:
            return None


def pending_summary(texts: AuthTexts, ticket: BrowserLoginTicket) -> str:
    """Render the accessible pending summary from a browser login ticket."""
    return (
        f"{texts.pending_code_label} {ticket.user_code} - "
        f"{texts.pending_uri_label} {ticket.verification_uri} - "
        f"{texts.pending_expiry_label} {int(ticket.poll_interval)}"
    )


def flow_announcement(
    texts: AuthTexts, outcome: OAuthState, account: OAuthAccount | None
) -> str:
    """Return the live announcement text for one settled flow outcome."""
    match outcome:
        case OAuthState.AUTHORIZED if account is not None:
            return texts.announcement_authenticated_format.format(
                account=account.username
            )
        case OAuthState.EXPIRED:
            return texts.expired_message
        case OAuthState.DENIED:
            return texts.denied_message
        case OAuthState.CANCELLED:
            return texts.cancelled_message
        case _:
            return texts.failed_message


def render_status(  # noqa: PLR0913 - one render call takes the full readout state
    widgets: PanelWidgets,
    texts: AuthTexts,
    *,
    ownership: AuthOwnership,
    shared_account: OAuthAccount | None,
    alias: CredentialAlias | None,
    browser_state: OAuthState,
) -> None:
    """Render the ownership readout and command visibility into the widgets."""
    label = ownership_label(texts, ownership)
    widgets.ownership_label.setText(label)
    widgets.ownership_label.setAccessibleName(label)
    if browser_state is not OAuthState.PENDING:
        # While pending the flow already rendered the code/URI/expiry summary
        # through set_status(); refresh must not clobber it with the ownership
        # label, otherwise the browser-code state shows the user nothing.
        message = browser_outcome_message(texts, browser_state)
        metadata = account_metadata(
            texts,
            ownership,
            shared_account=shared_account,
            alias=alias,
        )
        summary = message if message is not None else (metadata or label)
        widgets.status.text_label().setText(summary)
        widgets.status.setAccessibleName(summary)
        widgets.status.setToolTip(summary)
    has_shared = ownership is AuthOwnership.SHARED
    has_hubfetch = ownership is AuthOwnership.HUBFETCH_ONLY
    widgets.sign_in.setVisible(not has_shared)
    widgets.replace_button.setVisible(has_shared or has_hubfetch)
    widgets.delete_button.setVisible(has_shared or has_hubfetch)
    widgets.cancel_login.setVisible(browser_state is OAuthState.PENDING)
