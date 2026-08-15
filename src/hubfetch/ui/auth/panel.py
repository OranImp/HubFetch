"""Localized accessible authentication management panel.

The panel manages both auth paths in one surface: the shared machine browser
OAuth account and HubFetch-only manual tokens, with explicit ownership labels,
non-secret account/alias metadata, replace/delete confirmations, browser-code
pending/expired/denied/cancelled states, throttled live announcements, and no
token redisplay. Widget construction lives in :mod:`layout`, the browser-code
lifecycle in :mod:`browser_flow`, the masked token entry in :mod:`token_entry`,
and the ownership semantics in :mod:`ownership`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final, override

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QWidget

from hubfetch.auth.flow_models import OAuthState

from .browser_flow import BrowserFlowPresenter
from .dispatch import ThreadPoolWorkDispatcher
from .layout import (
    build_panel_widgets,
    command_buttons,
    focus_order,
    install_accelerators,
    rendered_texts,
)
from .ownership import (
    AuthOwnership,
    account_metadata,
    auth_source_semantics,
    derive_ownership,
    ownership_label,
    render_status,
)

if TYPE_CHECKING:
    from PySide6.QtGui import QKeyEvent
    from PySide6.QtWidgets import QLineEdit

    from hubfetch.auth.browser_oauth import OAuthAccount
    from hubfetch.credentials.models import CredentialAlias
    from hubfetch.domain.task_spec import AuthSource
    from hubfetch.ui.auth.dispatch import WorkDispatcher
    from hubfetch.ui.auth.layout import PanelWidgets
    from hubfetch.ui.auth.service import AuthPanelService
    from hubfetch.ui.auth.texts import AuthTexts
    from hubfetch.ui.auth.token_entry import TokenEntrySection
    from hubfetch.ui.widgets.buttons import ActionButton

__all__ = ["AuthOwnership", "AuthPanel"]


@final
class AuthPanel(QWidget):
    """One localized, keyboard-accessible auth management surface."""

    announced: Signal = Signal(str)

    __slots__: Final = (
        "_alias",
        "_browser_state",
        "_flow",
        "_ownership",
        "_section",
        "_service",
        "_shared_account",
        "_texts",
        "_widgets",
    )
    _texts: AuthTexts
    _service: AuthPanelService
    _flow: BrowserFlowPresenter
    _widgets: PanelWidgets
    _section: TokenEntrySection
    _ownership: AuthOwnership
    _browser_state: OAuthState
    _alias: CredentialAlias | None
    _shared_account: OAuthAccount | None

    def __init__(
        self,
        texts: AuthTexts,
        service: AuthPanelService,
        *,
        alias: CredentialAlias | None = None,
        shared_account: OAuthAccount | None = None,
        dispatcher: WorkDispatcher | None = None,
    ) -> None:
        """Compose the ownership readout, commands, and transient surfaces."""
        super().__init__()
        self._texts = texts
        self._service = service
        self._alias = alias
        self._shared_account = shared_account
        self._ownership = derive_ownership(shared_account=shared_account, alias=alias)
        self._browser_state = OAuthState.STARTED
        self.setAccessibleName(texts.title)
        self._widgets = build_panel_widgets(self, texts)
        self._section = self._widgets.section
        if alias is not None:
            self._section.bind_alias(alias)
        self._flow = BrowserFlowPresenter(
            service,
            dispatcher=dispatcher
            if dispatcher is not None
            else ThreadPoolWorkDispatcher(),
        )
        self._flow.attach(self)
        self._flow.settled.connect(self._on_flow_settled)
        self._flow.announced.connect(self.announced)
        self._connect()
        self._refresh()

    def _connect(self) -> None:
        """Bind every command to its typed handler and keyboard accelerator."""
        widgets = self._widgets
        widgets.sign_in.clicked.connect(self.sign_in_browser)
        widgets.replace_button.clicked.connect(self.request_replace)
        widgets.delete_button.clicked.connect(self.request_delete)
        widgets.cancel_login.clicked.connect(self.cancel_login)
        widgets.section.save_button().clicked.connect(self.save_token)
        widgets.section.confirm_replace_button().clicked.connect(self.confirm_replace)
        widgets.section.confirm_delete_button().clicked.connect(self.confirm_delete)
        widgets.section.changed.connect(self._on_token_changed)
        install_accelerators(widgets)

    def _on_token_changed(self, message: str) -> None:
        self._flow.announce(message)
        self._refresh()

    def _refresh(self) -> None:
        """Re-render the ownership readout from the current state."""
        self._ownership = derive_ownership(
            shared_account=self._shared_account, alias=self._alias
        )
        render_status(
            self._widgets,
            self._texts,
            ownership=self._ownership,
            shared_account=self._shared_account,
            alias=self._alias,
            browser_state=self._browser_state,
        )
        if self._browser_state is not OAuthState.PENDING:
            self._section.hide_entry()

    def set_status(self, text: str) -> None:
        """Update the single status pair's text and accessible name."""
        self._widgets.status.text_label().setText(text)
        self._widgets.status.setAccessibleName(text)
        self._widgets.status.setToolTip(text)

    def adopt_account(self, account: OAuthAccount) -> None:
        """Adopt the resolved shared machine account metadata."""
        self._shared_account = account

    def refresh(self) -> None:
        """Re-render the ownership readout from the current state."""
        self._refresh()

    def ownership(self) -> AuthOwnership:
        """Return the closed ownership of the current credential state."""
        return self._ownership

    def ownership_label(self) -> str:
        """Return the localized ownership label."""
        return ownership_label(self._texts, self._ownership)

    def account_metadata(self) -> str:
        """Return the non-secret account/alias metadata, or an empty string."""
        return account_metadata(
            self._texts,
            self._ownership,
            shared_account=self._shared_account,
            alias=self._alias,
        )

    def auth_source_semantics(self) -> AuthSource:
        """Return the task-spec auth-source semantics of the ownership."""
        return auth_source_semantics(self._ownership)

    def pending_user_code(self) -> str:
        """Return the user code of the pending browser login."""
        return self._flow.pending_user_code()

    def pending_verification_uri(self) -> str:
        """Return the verification URI of the pending browser login."""
        return self._flow.pending_verification_uri()

    def cancel_login_button(self) -> ActionButton:
        """Return the cancel-login command button."""
        return self._widgets.cancel_login

    def command_buttons(self) -> tuple[ActionButton, ...]:
        """Return every command in deterministic keyboard order."""
        return command_buttons(self._widgets)

    def focus_order(self) -> tuple[QWidget, ...]:
        """Return the deterministic tab/focus order of the interactive surface."""
        return focus_order(
            self._widgets, pending=self._browser_state is OAuthState.PENDING
        )

    def token_editor(self) -> QLineEdit:
        """Return the masked token editor (never echoes stored values)."""
        return self._section.token_editor()

    def bind_alias(self, alias: CredentialAlias) -> None:
        """Bind a HubFetch-only alias and re-render ownership."""
        self._alias = alias
        self._section.bind_alias(alias)
        self._refresh()

    def open_token_entry(self) -> None:
        """Open the masked token entry row for a fresh manual token."""
        self._section.open_add()

    def save_token(self) -> None:
        """Store the entered token through the service without redisplaying it."""
        self._section.save(self._service)
        alias = self._section.current_alias()
        if alias is not None:
            self._alias = alias

    def request_replace(self) -> None:
        """Open the replace confirmation surface."""
        self._section.request_replace()

    def confirm_replace(self) -> None:
        """Enter the masked token row in replace mode for the bound alias."""
        alias = self._alias
        if alias is not None:
            self._section.confirm_replace(alias)

    def request_delete(self) -> None:
        """Open the delete confirmation surface."""
        self._section.request_delete()

    def confirm_delete(self) -> None:
        """Delete the bound alias after explicit confirmation."""
        self._section.confirm_delete(self._service)
        self._alias = None
        self._refresh()

    def cancel_confirmation(self) -> None:
        """Dismiss any open confirmation without calling the service."""
        self._section.cancel_confirmation()

    def confirm_pending(self) -> bool:
        """Return whether a replace/delete confirmation is open."""
        return self._section.confirm_pending()

    def sign_in_browser(self) -> None:
        """Start the shared browser login or render its diagnostic."""
        _ = self._flow.start(self._texts)

    def cancel_login(self) -> None:
        """Cancel the pending browser login and settle as cancelled."""
        self._flow.cancel(self._texts)

    def _on_flow_settled(self, outcome: object) -> None:
        """Settle the browser login from the typed poll outcome."""
        if self._browser_state is OAuthState.PENDING:
            self._flow.settle(outcome, self._texts)

    def set_browser_state(self, state: OAuthState) -> None:
        """Record the current browser-code flow state on the panel."""
        self._browser_state = state

    def browser_state(self) -> OAuthState:
        """Return the current browser-code flow state."""
        return self._browser_state

    def rendered_texts(self) -> tuple[str, ...]:
        """Return every currently rendered text for no-redisplay assertions."""
        return rendered_texts(
            self._widgets, status=self._widgets.status.text_label().text()
        )

    def last_announcement(self) -> str:
        """Return the most recently emitted live announcement."""
        return self._flow.last_announcement()

    @override
    def keyPressEvent(self, event: QKeyEvent) -> None:
        """Route Escape to the active transient surface."""
        if event.key() == Qt.Key.Key_Escape:
            if self._browser_state is OAuthState.PENDING:
                self.cancel_login()
                return
            if self.confirm_pending():
                self.cancel_confirmation()
                return
        super().keyPressEvent(event)
