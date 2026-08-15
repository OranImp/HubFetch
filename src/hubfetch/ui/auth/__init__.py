"""Localized accessible authentication management for HubFetch.

Todo 28 integrates shared browser OAuth and HubFetch-only manual token
management into the Settings and creation surfaces. The package owns the
bilingual :class:`AuthTexts` vocabulary, the typed :class:`AuthPanelService`
seam (plus its runtime adapter over the Todo 9 auth service and Todo 8
credential store), the off-thread :class:`WorkDispatcher` family, and the
:class:`AuthPanel` management surface. Token values never cross into the UI:
the panel renders only ownership labels and non-secret metadata, and the token
editor masks every input.
"""

from __future__ import annotations

from .dispatch import (
    CapturingWorkDispatcher,
    SynchronousWorkDispatcher,
    ThreadPoolWorkDispatcher,
    WorkDispatcher,
)
from .panel import AuthOwnership, AuthPanel
from .service import AuthPanelService, BrowserLoginTicket, RuntimeAuthPanelService
from .texts import AuthTexts

__all__ = [
    "AuthOwnership",
    "AuthPanel",
    "AuthPanelService",
    "AuthTexts",
    "BrowserLoginTicket",
    "CapturingWorkDispatcher",
    "RuntimeAuthPanelService",
    "SynchronousWorkDispatcher",
    "ThreadPoolWorkDispatcher",
    "WorkDispatcher",
]
