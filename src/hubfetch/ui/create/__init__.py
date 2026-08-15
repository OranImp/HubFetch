"""Transient Download and Clone creation flows.

Separate, typed creation dialogs for file/snapshot downloads and real Git
clones, launched from distinct shell commands. The dialogs run Todo 17 planning
and Todo 12/19 preflight off the GUI thread, present estimates before Confirm
enqueues through the application runtime, and never combine the two kinds into
an ambiguous wizard.
"""

from __future__ import annotations

from .clone_dialog import CloneDialog
from .clone_form import CloneForm
from .contracts import (
    CloneCreateService,
    ClonePreflight,
    ConflictChoice,
    CreateFlowState,
    DestinationChoice,
    DownloadCreateService,
    DownloadMode,
    FieldError,
    TaskIdFactory,
    TransportChoice,
    UuidTaskIdFactory,
    WorkDispatcher,
)
from .download_dialog import DownloadDialog
from .download_form import DownloadForm
from .texts import CreateTexts

__all__ = [
    "CloneCreateService",
    "CloneDialog",
    "CloneForm",
    "ClonePreflight",
    "ConflictChoice",
    "CreateFlowState",
    "CreateTexts",
    "DestinationChoice",
    "DownloadCreateService",
    "DownloadDialog",
    "DownloadForm",
    "DownloadMode",
    "FieldError",
    "TaskIdFactory",
    "TransportChoice",
    "UuidTaskIdFactory",
    "WorkDispatcher",
]
