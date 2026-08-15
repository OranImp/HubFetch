"""Copyable install-guidance logic for the Diagnostics surface.

Install guidance is display-only copyable text: it is never auto-run. This
module owns the guidance assembly (static Git/Git-Xet lines plus any report
entry guidance) and the clipboard write through a structural seam satisfied by
QClipboard and test doubles.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from PySide6.QtWidgets import QApplication

from hubfetch.diagnostics.git import (
    GIT_INSTALL_GUIDANCE,
    XET_INIT_GUIDANCE,
    XET_INSTALL_GUIDANCE,
)

if TYPE_CHECKING:
    from .models import DiagnosticsReport

__all__ = [
    "TextClipboard",
    "copy_install_guidance",
    "install_guidance_text",
]


class TextClipboard(Protocol):
    """Structural clipboard seam satisfied by QClipboard and test doubles."""

    def setText(self, text: str) -> None:  # noqa: N802 - Qt API naming
        """Replace the clipboard contents with ``text``."""


def install_guidance_text(report: DiagnosticsReport | None) -> str:
    """Return the copyable non-elevated install guidance."""
    lines = [GIT_INSTALL_GUIDANCE, XET_INSTALL_GUIDANCE, XET_INIT_GUIDANCE]
    if report is not None:
        for category in report.categories:
            for entry in category.entries:
                lines.extend(entry.guidance)
    return "\n".join(dict.fromkeys(lines))


def copy_install_guidance(text: str, clipboard: TextClipboard | None = None) -> None:
    """Copy the given guidance to the clipboard."""
    target = clipboard if clipboard is not None else QApplication.clipboard()
    target.setText(text)
