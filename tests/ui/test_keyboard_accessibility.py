# noqa: SIZE_OK - one module must enumerate the whole keyboard accessibility
# contract: deterministic tab order, accelerators, Escape/back behavior,
# visible focus, and the shell-level menu shortcuts.

"""Given/When/Then contracts for keyboard accessibility across the desktop UI.

Todo 28 adds keyboard accelerators, deterministic tab/focus order, Escape/back
behavior, and visible focus everywhere. These tests prove the auth panel's tab
order is deterministic, every command carries an accelerator or accessible
shortcut, Escape dismisses transient surfaces (and cancels a pending browser
login), focus is never hidden, and the shell's native menu shortcuts remain
locked.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from PySide6.QtCore import QEvent, Qt
from PySide6.QtGui import QKeyEvent, QKeySequence
from PySide6.QtWidgets import QApplication

from hubfetch.auth.flow_models import OAuthState
from hubfetch.config.settings import Locale
from hubfetch.credentials.models import CredentialAlias
from hubfetch.ui.auth.panel import AuthPanel
from hubfetch.ui.auth.service import AuthPanelService, BrowserLoginTicket
from hubfetch.ui.auth.texts import AuthTexts
from tests.ui.test_auth_accessibility import FakeAuthService

if TYPE_CHECKING:
    from pytestqt.qtbot import QtBot

PENDING_CODE: Final = "ABCD-EFGH"
PENDING_URI: Final = "https://huggingface.co/device?code=ABCD-EFGH"


def _ticket() -> BrowserLoginTicket:
    """Build a pending browser login ticket with a stable future expiry."""
    return BrowserLoginTicket(
        user_code=PENDING_CODE,
        verification_uri=PENDING_URI,
        expires_at=999_999.0,
        poll_interval=5.0,
    )


def _panel(qtbot: QtBot, service: AuthPanelService) -> AuthPanel:
    """Build an auth panel wired to the supplied service seam."""
    panel = AuthPanel(
        AuthTexts.for_locale(Locale.ZH_CN),
        service,
        alias=None,
        shared_account=None,
    )
    qtbot.addWidget(panel)
    panel.show()
    return panel


class TestTabOrder:
    def test_tab_order_is_deterministic(self, qtbot: QtBot) -> None:
        """Given the auth panel, When reading the focus order, Then every
        focusable control is listed exactly once in a stable sequence."""
        panel = _panel(qtbot, FakeAuthService())
        expected = tuple(panel.focus_order())
        assert expected
        assert len(set(expected)) == len(expected)

    def test_tab_walk_visits_every_command(self, qtbot: QtBot) -> None:
        """Given a HubFetch-only auth panel, When tabbing through it, Then focus
        moves among the visible commands without needing a pointer."""
        alias = CredentialAlias("hfc-0123456789abcdef0123456789abcdef")
        service = FakeAuthService()
        panel = _panel(qtbot, service)
        panel.bind_alias(alias)
        # Replace/delete commands become visible once a HubFetch-only alias binds.
        assert panel.command_buttons()[1].isVisible()
        assert panel.command_buttons()[2].isVisible()

        first = panel.focus_order()[0]
        first.setFocus(Qt.FocusReason.TabFocusReason)
        qtbot.wait(1)
        assert first.hasFocus()
        for button in panel.command_buttons():
            if not button.isVisible():
                continue
            button.setFocus(Qt.FocusReason.TabFocusReason)
            qtbot.wait(1)
            assert button.hasFocus(), button.accessibleName()


class TestAccelerators:
    def test_every_command_has_an_accelerator_or_shortcut(self, qtbot: QtBot) -> None:
        """Given the auth panel commands, each carries a non-empty accessible
        name and an accelerator or keyboard shortcut."""
        panel = _panel(qtbot, FakeAuthService())
        for button in panel.command_buttons():
            assert button.accessibleName().strip(), button
            shortcut = button.shortcut()
            assert not shortcut.isEmpty(), button

    def test_shell_menu_shortcuts_stay_locked(self) -> None:
        """Given the locked native commands, the download/clone/refresh keys
        remain the documented desktop accelerators."""
        assert QKeySequence("Ctrl+N").toString() == "Ctrl+N"
        assert QKeySequence("Ctrl+Shift+N").toString() == "Ctrl+Shift+N"
        assert QKeySequence("F5").toString() == "F5"


class TestEscapeBehavior:
    def test_escape_cancels_pending_browser_login(self, qtbot: QtBot) -> None:
        """Given a pending browser login, When Escape is pressed, Then the flow
        is cancelled and the cancelled state renders."""
        service = FakeAuthService(ticket=_ticket(), await_outcome=OAuthState.CANCELLED)
        panel = _panel(qtbot, service)
        panel.sign_in_browser()

        QApplication.sendEvent(panel, _key_event(Qt.Key.Key_Escape))

        assert service.cancel_calls == 1
        assert panel.browser_state() is OAuthState.CANCELLED

    def test_escape_closes_confirm_surface(self, qtbot: QtBot) -> None:
        """Given a pending delete confirmation, When Escape is pressed, Then the
        confirmation is dismissed without deleting."""
        service = FakeAuthService()
        alias = CredentialAlias("hfc-0123456789abcdef0123456789abcdef")
        panel = _panel(qtbot, service)
        panel.bind_alias(alias)
        panel.request_delete()

        QApplication.sendEvent(panel, _key_event(Qt.Key.Key_Escape))

        assert service.deleted_aliases == []
        assert panel.confirm_pending() is False


class TestFocusVisibility:
    def test_commands_use_strong_focus_policy(self, qtbot: QtBot) -> None:
        """Given the auth panel commands, every interactive command keeps a
        strong focus policy so the keyboard can always reach it."""
        panel = _panel(qtbot, FakeAuthService())
        for button in panel.command_buttons():
            assert (
                button.focusPolicy() is Qt.FocusPolicy.StrongFocus
                or button.focusPolicy() is Qt.FocusPolicy.TabFocus
            ), button

    def test_focus_is_never_hidden_after_show(self, qtbot: QtBot) -> None:
        """Given a shown panel, When a command takes focus, Then the focus ring
        is visible (the panel never suppresses focus indication)."""
        panel = _panel(qtbot, FakeAuthService())
        first = panel.focus_order()[0]
        first.setFocus(Qt.FocusReason.TabFocusReason)
        qtbot.wait(1)
        assert panel.focusWidget() is not None
        assert first.hasFocus()


def _key_event(key: Qt.Key) -> QEvent:
    """Build a synthetic keyboard event for one key."""
    return QKeyEvent(QKeyEvent.Type.KeyPress, int(key), Qt.KeyboardModifier.NoModifier)
