"""Browser-code login presenter: starts, awaits, and settles one login.

The presenter owns the shared browser OAuth flow state (pending, expired,
denied, cancelled, failed, authorized), the off-thread dispatch of the
blocking authorization poll, and the status/announcement/account side effects
through the injected :class:`FlowHost` callbacks. The panel keeps thin
delegation methods; token bytes never cross this boundary.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, Protocol, final, runtime_checkable

from PySide6.QtCore import QElapsedTimer, QObject, Signal

from hubfetch.auth.flow_models import OAuthState

from .dispatch import SynchronousWorkDispatcher, WorkDispatcher
from .ownership import flow_announcement, pending_summary

if TYPE_CHECKING:
    from hubfetch.auth.browser_oauth import OAuthAccount

    from .service import AuthPanelService, BrowserLoginTicket
    from .texts import AuthTexts

__all__ = ["BrowserFlowPresenter", "FlowHost"]

_ANNOUNCE_THROTTLE_MS: Final[int] = 300


@runtime_checkable
class FlowHost(Protocol):
    """The panel surface the flow presenter renders into."""

    def set_status(self, text: str) -> None:
        """Render one status message into the panel's status pair."""
        ...

    def adopt_account(self, account: OAuthAccount) -> None:
        """Adopt the resolved shared machine account metadata."""
        ...

    def refresh(self) -> None:
        """Re-render the ownership readout from the current state."""
        ...

    def set_browser_state(self, state: OAuthState) -> None:
        """Record the current browser-code flow state on the panel."""
        ...

    def browser_state(self) -> OAuthState:
        """Return the panel's current browser-code flow state."""
        ...


@final
class BrowserFlowPresenter(QObject):
    """One shared browser login lifecycle with typed outcome settlement."""

    settled: Signal = Signal(object)
    """Emitted once with the terminal ``OAuthState`` after the poll settles."""

    announced: Signal = Signal(str)
    """Live announcement, throttled to one per message per interval."""

    __slots__: Final = (
        "_announce_text",
        "_announce_timer",
        "_dispatcher",
        "_host",
        "_service",
        "_ticket",
    )

    _service: AuthPanelService
    _dispatcher: WorkDispatcher
    _host: FlowHost | None
    _ticket: BrowserLoginTicket | None
    _announce_text: str
    _announce_timer: QElapsedTimer

    def __init__(
        self,
        service: AuthPanelService,
        *,
        dispatcher: WorkDispatcher | None = None,
    ) -> None:
        """Bind the service seam, the host, and the off-thread dispatcher."""
        super().__init__()
        self._service = service
        self._host = None
        self._dispatcher = (
            dispatcher if dispatcher is not None else SynchronousWorkDispatcher()
        )
        self._ticket = None
        self._announce_text = ""
        self._announce_timer = QElapsedTimer()
        self._announce_timer.start()

    def attach(self, host: FlowHost) -> None:
        """Attach the panel surface that renders flow state changes."""
        self._host = host

    def start(self, texts: AuthTexts) -> bool:
        """Start the browser login and render the pending or failure state.

        Returns whether the flow is now awaiting authorization.
        """
        host = self._host
        if host is None:
            return False
        if not self._service.shared_oauth_available():
            diagnostic = self._service.shared_oauth_diagnostic()
            message = diagnostic or texts.unavailable_message
            host.set_status(message)
            host.set_browser_state(OAuthState.FAILED)
            self.announce(message)
            return False
        summary = self.begin(texts)
        if summary is None:
            message = texts.unavailable_message
            host.set_status(message)
            host.set_browser_state(OAuthState.FAILED)
            self.announce(message)
            return False
        host.set_browser_state(OAuthState.PENDING)
        host.set_status(summary)
        host.refresh()
        self.submit_await()
        return True

    def cancel(self, texts: AuthTexts) -> None:
        """Cancel the pending browser login and settle as cancelled."""
        self._service.cancel_browser_login()
        self._ticket = None
        host = self._host
        if host is not None:
            host.set_browser_state(OAuthState.CANCELLED)
            host.refresh()
        self.announce(texts.cancelled_message)

    def settle(self, outcome: object, texts: AuthTexts) -> None:
        """Settle the browser login from a typed poll outcome."""
        host = self._host
        if host is None:
            return
        if not isinstance(outcome, OAuthState):
            outcome = OAuthState.FAILED
        account = None
        if outcome is OAuthState.AUTHORIZED:
            account = self.authorized_account()
            if account is not None:
                host.adopt_account(account)
        host.set_browser_state(outcome)
        self.announce(flow_announcement(texts, outcome, account))
        host.refresh()

    def fail(self, texts: AuthTexts) -> None:
        """Settle the browser login as failed with an accessible message."""
        self.announce(texts.failed_message)

    def last_announcement(self) -> str:
        """Return the most recently emitted announcement."""
        return self._announce_text

    def announce(self, message: str) -> None:
        """Emit a live announcement, throttling repeats within the window."""
        elapsed = self._announce_timer.elapsed()
        if message == self._announce_text and elapsed < _ANNOUNCE_THROTTLE_MS:
            return
        self._announce_text = message
        self._announce_timer.restart()
        self.announced.emit(message)

    def begin(self, texts: AuthTexts) -> str | None:
        """Start the browser login and return its accessible pending summary.

        Returns ``None`` when the shared adapter is unavailable or no pending
        ticket could be produced, so the caller can render the diagnostic.
        """
        if not self._service.shared_oauth_available():
            return None
        ticket = self._service.begin_browser_login()
        if ticket is None:
            return None
        self._ticket = ticket
        return pending_summary(texts, ticket)

    def submit_await(self) -> None:
        """Run the blocking authorization poll off the GUI thread."""
        self._dispatcher.submit(
            self._service.await_authorization,
            self._on_settled,
            self._on_error,
        )

    def pending_user_code(self) -> str:
        """Return the pending user code, or an empty string when idle."""
        ticket = self._ticket
        return ticket.user_code if ticket is not None else ""

    def pending_verification_uri(self) -> str:
        """Return the pending verification URI, or an empty string when idle."""
        ticket = self._ticket
        return ticket.verification_uri if ticket is not None else ""

    def authorized_account(self) -> OAuthAccount | None:
        """Return the resolved shared account, if the flow authorized."""
        return self._service.authorized_account()

    def _on_settled(self, outcome: object) -> None:
        """Route the typed poll outcome to the caller's settlement handler."""
        self._ticket = None
        self.settled.emit(outcome)

    def _on_error(self, error: BaseException) -> None:
        """Settle as failed when the poll boundary rejects the work."""
        del error
        self._ticket = None
        self.settled.emit(OAuthState.FAILED)
