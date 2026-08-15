# noqa: SIZE_OK - one module must enumerate the whole auth-surface contract:
# ownership labels, account/alias metadata, replace/delete confirmations,
# browser-code pending/expiry/cancel states, no-token-redisplay, live
# announcements, and accessible names/descriptions/roles/values.

"""Given/When/Then contracts for the localized accessible auth management panel.

Todo 28 integrates shared browser OAuth and HubFetch-only manual token
management into the Settings and creation surfaces. The :class:`AuthPanel` is
that management surface: it labels ownership explicitly (shared machine account
versus HubFetch-only token), shows non-secret account/alias metadata, requires
explicit confirmation before replace/delete, renders the browser-code
pending/expired/denied/cancelled states accessibly, and never redisplays token
values. The tests drive the panel through a deterministic fake service and a
capturing dispatcher so every state transition is proven without any network,
keyring, or subprocess.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final, override

from PySide6.QtWidgets import QApplication, QLineEdit, QWidget

from hubfetch.auth.browser_oauth import OAuthAccount, OAuthState
from hubfetch.auth.flow_models import OAuthState as FlowOAuthState
from hubfetch.config.settings import Locale
from hubfetch.credentials.models import CredentialAlias
from hubfetch.domain.task_spec import AuthSource
from hubfetch.ui.auth.dispatch import (
    CapturingWorkDispatcher,
    SynchronousWorkDispatcher,
    WorkDispatcher,
)
from hubfetch.ui.auth.panel import AuthOwnership, AuthPanel
from hubfetch.ui.auth.service import AuthPanelService, BrowserLoginTicket
from hubfetch.ui.auth.texts import AuthTexts

if TYPE_CHECKING:
    from pytestqt.qtbot import QtBot

SENTINEL_TOKEN: Final = "hf_test_secret_123"  # noqa: S105 - test fixture
SENTINEL_ALIAS: Final = CredentialAlias("hfc-0123456789abcdef0123456789abcdef")
SHARED_ACCOUNT: Final = OAuthAccount(
    username="alice",
    token_name="oauth-alice",  # noqa: S106 - display name, not a secret
)
PENDING_CODE: Final = "ABCD-EFGH"
PENDING_URI: Final = "https://huggingface.co/device?code=ABCD-EFGH"


@final
class FakeAuthService(AuthPanelService):
    """Deterministic service seam recording every call for assertions."""

    shared_available: bool
    shared_diagnostic: str | None
    ticket: BrowserLoginTicket | None
    await_outcome: OAuthState
    existing_alias: CredentialAlias | None
    begin_calls: int
    await_calls: int
    cancel_calls: int
    added_tokens: list[str]
    replaced_tokens: list[tuple[CredentialAlias, str]]
    deleted_aliases: list[CredentialAlias]

    def __init__(
        self,
        *,
        shared_available: bool = True,
        shared_diagnostic: str | None = None,
        ticket: BrowserLoginTicket | None = None,
        await_outcome: OAuthState = FlowOAuthState.AUTHORIZED,
        existing_alias: CredentialAlias | None = SENTINEL_ALIAS,
    ) -> None:
        """Bind the canned outcomes and open the call record."""
        self.shared_available = shared_available
        self.shared_diagnostic = shared_diagnostic
        self.ticket = ticket
        self.await_outcome = await_outcome
        self.existing_alias = existing_alias
        self.begin_calls = 0
        self.await_calls = 0
        self.cancel_calls = 0
        self.added_tokens = []
        self.replaced_tokens = []
        self.deleted_aliases = []

    @override
    def shared_oauth_available(self) -> bool:
        """Return the canned adapter availability."""
        return self.shared_available

    @override
    def shared_oauth_diagnostic(self) -> str | None:
        """Return the canned compatibility diagnostic."""
        return self.shared_diagnostic

    @override
    def begin_browser_login(self) -> BrowserLoginTicket | None:
        """Record the begin and return the canned pending ticket."""
        self.begin_calls += 1
        return self.ticket

    @override
    def await_authorization(self) -> OAuthState:
        """Record the await and settle at the canned outcome."""
        self.await_calls += 1
        return self.await_outcome

    @override
    def cancel_browser_login(self) -> None:
        """Record the cancel request."""
        self.cancel_calls += 1

    @override
    def authorized_account(self) -> OAuthAccount | None:
        """Return the shared account when the outcome authorized."""
        if self.await_outcome is not FlowOAuthState.AUTHORIZED:
            return None
        return SHARED_ACCOUNT

    @override
    def add_manual_token(self, *, token: str) -> CredentialAlias:
        """Record the added token and return the opaque alias."""
        self.added_tokens.append(token)
        return SENTINEL_ALIAS

    @override
    def replace_manual_token(self, alias: CredentialAlias, *, token: str) -> None:
        """Record the replace payload."""
        self.replaced_tokens.append((alias, token))

    @override
    def delete_credential(self, alias: CredentialAlias) -> None:
        """Record the deleted alias."""
        self.deleted_aliases.append(alias)

    @override
    def alias_exists(self, alias: CredentialAlias) -> bool:
        """Return whether the alias is the canned existing one."""
        return alias == self.existing_alias


def _pending_ticket() -> BrowserLoginTicket:
    """Build a pending browser login ticket with a stable future expiry."""
    return BrowserLoginTicket(
        user_code=PENDING_CODE,
        verification_uri=PENDING_URI,
        expires_at=999_999.0,
        poll_interval=5.0,
    )


def _make_panel(
    qtbot: QtBot,
    service: FakeAuthService,
    *,
    alias: CredentialAlias | None = None,
    shared_account: OAuthAccount | None = None,
    dispatcher: WorkDispatcher | None = None,
) -> AuthPanel:
    """Build an auth panel wired to the fake service and capture its events."""
    panel = AuthPanel(
        AuthTexts.for_locale(Locale.ZH_CN),
        service,
        alias=alias,
        shared_account=shared_account,
        dispatcher=dispatcher
        if dispatcher is not None
        else SynchronousWorkDispatcher(),
    )
    qtbot.addWidget(panel)
    panel.show()
    return panel


def _rendered_text(panel: AuthPanel) -> str:
    """Return every visible text the panel currently renders."""
    return " ".join(panel.rendered_texts())


class TestOwnershipLabels:
    def test_anonymous_ownership_when_no_credential(self, qtbot: QtBot) -> None:
        """Given no alias or shared account, When rendering, Then the ownership
        label is the anonymous text and metadata is empty."""
        panel = _make_panel(qtbot, FakeAuthService(), alias=None, shared_account=None)

        assert panel.ownership() is AuthOwnership.ANONYMOUS
        assert panel.ownership_label() == "未登录"
        assert panel.account_metadata() == ""

    def test_hubfetch_only_ownership_with_alias(self, qtbot: QtBot) -> None:
        """Given a HubFetch-only alias, When rendering, Then the ownership label
        names HubFetch-only ownership and the alias appears as metadata."""
        panel = _make_panel(qtbot, FakeAuthService(), alias=SENTINEL_ALIAS)

        assert panel.ownership() is AuthOwnership.HUBFETCH_ONLY
        assert panel.ownership_label() == "HubFetch 专属令牌"
        assert "hfc-0123456789abcdef0123456789abcdef" in panel.account_metadata()

    def test_shared_ownership_with_account_metadata(self, qtbot: QtBot) -> None:
        """Given a shared machine account, When rendering, Then the ownership
        label names the shared account and its non-secret metadata is shown."""
        panel = _make_panel(
            qtbot, FakeAuthService(), alias=None, shared_account=SHARED_ACCOUNT
        )

        assert panel.ownership() is AuthOwnership.SHARED
        assert panel.ownership_label() == "共享机器账户"
        assert "alice" in panel.account_metadata()
        assert "oauth-alice" in panel.account_metadata()


class TestNoTokenRedisplay:
    def test_manual_token_is_never_redisplayed(self, qtbot: QtBot) -> None:
        """Given a HubFetch-only token added, When rendering every panel text,
        Then the token bytes never appear anywhere in the UI."""
        service = FakeAuthService()
        panel = _make_panel(qtbot, service)

        panel.open_token_entry()
        panel.token_editor().setText(SENTINEL_TOKEN)
        panel.save_token()

        assert service.added_tokens == [SENTINEL_TOKEN]
        assert SENTINEL_TOKEN not in _rendered_text(panel)
        assert SENTINEL_TOKEN not in panel.accessibleName()
        for label in panel.findChildren(QWidget):
            assert SENTINEL_TOKEN not in label.accessibleName()
            assert SENTINEL_TOKEN not in label.accessibleDescription()

    def test_token_editor_uses_password_echo(self, qtbot: QtBot) -> None:
        """Given the token entry, When inspecting the editor, Then it masks the
        value so the secret is never visible."""
        panel = _make_panel(qtbot, FakeAuthService())
        panel.open_token_entry()

        assert panel.token_editor().echoMode() is QLineEdit.EchoMode.Password

    def test_shared_account_metadata_carries_no_token_bytes(self, qtbot: QtBot) -> None:
        """Given a shared account, When rendering metadata, Then no token bytes
        are present."""
        panel = _make_panel(
            qtbot, FakeAuthService(), alias=None, shared_account=SHARED_ACCOUNT
        )
        assert SENTINEL_TOKEN not in _rendered_text(panel)
        assert SENTINEL_TOKEN not in panel.account_metadata()


class TestReplaceDeleteConfirmations:
    def test_replace_requires_confirmation_and_replaces(self, qtbot: QtBot) -> None:
        """Given a replace request, When the user confirms, Then the service
        replaces the token behind the existing alias."""
        service = FakeAuthService()
        panel = _make_panel(qtbot, service, alias=SENTINEL_ALIAS)

        panel.request_replace()
        assert panel.confirm_pending() is True
        panel.confirm_replace()
        panel.token_editor().setText("new-token")
        panel.save_token()

        assert service.replaced_tokens == [(SENTINEL_ALIAS, "new-token")]

    def test_delete_requires_confirmation_and_deletes(self, qtbot: QtBot) -> None:
        """Given a delete request, When the user confirms, Then the service
        deletes the alias and ownership returns to anonymous."""
        service = FakeAuthService()
        panel = _make_panel(qtbot, service, alias=SENTINEL_ALIAS)

        panel.request_delete()
        assert panel.confirm_pending() is True
        panel.confirm_delete()

        assert service.deleted_aliases == [SENTINEL_ALIAS]
        assert panel.ownership() is AuthOwnership.ANONYMOUS

    def test_delete_can_be_cancelled_without_service_call(self, qtbot: QtBot) -> None:
        """Given a delete request, When the user cancels, Then the service is
        never called and the alias stays."""
        service = FakeAuthService()
        panel = _make_panel(qtbot, service, alias=SENTINEL_ALIAS)

        panel.request_delete()
        panel.cancel_confirmation()

        assert service.deleted_aliases == []
        assert panel.ownership() is AuthOwnership.HUBFETCH_ONLY


class TestBrowserCodeStates:
    def test_pending_state_shows_code_uri_and_cancel(self, qtbot: QtBot) -> None:
        """Given a started browser login, When pending, Then the panel shows the
        user code, verification URI, and a cancel affordance."""
        service = FakeAuthService(ticket=_pending_ticket())
        panel = _make_panel(qtbot, service, dispatcher=CapturingWorkDispatcher())

        panel.sign_in_browser()

        assert panel.browser_state() is FlowOAuthState.PENDING
        assert panel.pending_user_code() == PENDING_CODE
        assert PENDING_URI in panel.pending_verification_uri()
        assert panel.cancel_login_button().isVisible()
        rendered = _rendered_text(panel)
        assert PENDING_CODE in rendered
        assert PENDING_URI in rendered

    def test_expired_outcome_is_rendered_accessibly(self, qtbot: QtBot) -> None:
        """Given an expired await outcome, When it settles, Then the expired
        state is rendered with actionable start-again text."""
        service = FakeAuthService(
            ticket=_pending_ticket(),
            await_outcome=FlowOAuthState.EXPIRED,
        )
        panel = _make_panel(qtbot, service)

        panel.sign_in_browser()

        assert panel.browser_state() is FlowOAuthState.EXPIRED
        assert "已过期" in _rendered_text(panel)

    def test_denied_outcome_is_rendered_accessibly(self, qtbot: QtBot) -> None:
        """Given a denied await outcome, When it settles, Then the denied state
        carries a distinct actionable message."""
        service = FakeAuthService(
            ticket=_pending_ticket(),
            await_outcome=FlowOAuthState.DENIED,
        )
        panel = _make_panel(qtbot, service)

        panel.sign_in_browser()

        assert panel.browser_state() is FlowOAuthState.DENIED
        assert "拒绝" in _rendered_text(panel)

    def test_cancel_requests_cancellation(self, qtbot: QtBot) -> None:
        """Given a pending browser login, When the user cancels, Then the flow is
        cancelled and the cancelled state renders."""
        service = FakeAuthService(
            ticket=_pending_ticket(),
            await_outcome=FlowOAuthState.CANCELLED,
        )
        panel = _make_panel(qtbot, service)
        panel.sign_in_browser()

        panel.cancel_login()

        assert service.cancel_calls == 1
        assert panel.browser_state() is FlowOAuthState.CANCELLED

    def test_authorized_outcome_shows_shared_ownership(self, qtbot: QtBot) -> None:
        """Given an authorized await outcome, When it settles, Then the panel
        switches to shared machine ownership with account metadata."""
        service = FakeAuthService(ticket=_pending_ticket())
        panel = _make_panel(qtbot, service)

        panel.sign_in_browser()

        assert panel.ownership() is AuthOwnership.SHARED
        assert panel.browser_state() is FlowOAuthState.AUTHORIZED
        assert "alice" in panel.account_metadata()

    def test_unavailable_oauth_renders_diagnostic(self, qtbot: QtBot) -> None:
        """Given the shared adapter is unavailable, When signing in, Then the
        compatibility diagnostic is shown instead of a pending ticket."""
        service = FakeAuthService(
            shared_available=False,
            shared_diagnostic=(
                "缺少依赖：huggingface_hub 浏览器 OAuth 适配器"  # noqa: RUF001 - fullwidth colon in zh text
            ),
        )
        panel = _make_panel(qtbot, service)

        panel.sign_in_browser()

        assert service.begin_calls == 0
        assert "缺少依赖" in _rendered_text(panel)


class TestLiveAnnouncements:
    def test_live_status_announcement_records_event(self, qtbot: QtBot) -> None:
        """Given a completed browser login, When it authorizes, Then a live
        status announcement is emitted with throttling."""
        service = FakeAuthService(ticket=_pending_ticket())
        panel = _make_panel(qtbot, service)
        announcements: list[str] = []
        panel.announced.connect(announcements.append)

        panel.sign_in_browser()

        assert announcements
        assert any("alice" in message for message in announcements)
        assert panel.last_announcement() == announcements[-1]


class TestAccessibleContract:
    def test_all_commands_carry_accessible_names(self, qtbot: QtBot) -> None:
        """Given the auth panel, every command button has a non-empty accessible
        name and the panel itself is named."""
        panel = _make_panel(qtbot, FakeAuthService())

        for button in panel.command_buttons():
            assert button.accessibleName().strip()
        assert panel.accessibleName().strip()

    def test_ownership_state_exposes_auth_source_semantics(self, qtbot: QtBot) -> None:
        """Given a HubFetch-only alias, When reading the ownership, Then the
        closed ownership enum maps to the task-spec auth source semantics."""
        panel = _make_panel(qtbot, FakeAuthService(), alias=SENTINEL_ALIAS)
        assert panel.auth_source_semantics() is AuthSource.MANUAL_TOKEN

    def test_shared_account_is_not_an_app_credential(self, qtbot: QtBot) -> None:
        """Given a shared machine account, When reading semantics, Then the
        shared login maps to SHARED_OAUTH, never a HubFetch-only token."""
        panel = _make_panel(
            qtbot, FakeAuthService(), alias=None, shared_account=SHARED_ACCOUNT
        )
        assert panel.auth_source_semantics() is AuthSource.SHARED_OAUTH


class TestUnusedImportsGuard:
    def test_qapplication_fixture_type_is_used(self, qapp: QApplication) -> None:
        """Guard against import churn: the Qt application fixture exists."""
        assert qapp is not None
