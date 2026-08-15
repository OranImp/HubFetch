"""Widget construction for the auth management panel.

The panel keeps only behavior and state; this module owns the concrete widget
layout (ownership readout, command rows, and the token/confirmation section)
and returns a typed :class:`PanelWidgets` record. Splitting construction from
behavior keeps both modules under the source-size ceiling.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from PySide6.QtGui import QKeySequence
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from hubfetch.ui import tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.status import StatusPair, StatusSeverity

from .token_entry import TokenEntrySection

if TYPE_CHECKING:
    from hubfetch.ui.auth.texts import AuthTexts

__all__ = [
    "PanelWidgets",
    "build_panel_widgets",
    "command_buttons",
    "focus_order",
    "install_accelerators",
    "rendered_texts",
]

_LAYOUT_MARGINS: Final = (
    tokens.SPACE_LG,
    tokens.SPACE_LG,
    tokens.SPACE_LG,
    tokens.SPACE_LG,
)


@dataclass(frozen=True, slots=True)
class PanelWidgets:
    """Every widget the auth panel composes, in construction order."""

    ownership_label: QLabel
    status: StatusPair
    sign_in: ActionButton
    replace_button: ActionButton
    delete_button: ActionButton
    cancel_login: ActionButton
    section: TokenEntrySection
    layout: QVBoxLayout


def build_panel_widgets(panel: QWidget, texts: AuthTexts) -> PanelWidgets:
    """Construct the full auth panel widget tree and return its record."""
    layout = QVBoxLayout(panel)
    layout.setContentsMargins(*_LAYOUT_MARGINS)
    layout.setSpacing(tokens.SPACE_MD)
    ownership_label = QLabel("")
    title_font = ownership_label.font()
    title_font.setBold(True)
    ownership_label.setFont(title_font)
    layout.addWidget(ownership_label)
    status = StatusPair(StatusSeverity.INFO, "")
    layout.addWidget(status)
    commands = QHBoxLayout()
    commands.setSpacing(tokens.SPACE_SM)
    sign_in = ActionButton(texts.sign_in_browser)
    cancel_login = ActionButton(texts.cancel_command)
    replace_button = ActionButton(texts.replace_command)
    delete_button = ActionButton(texts.delete_command)
    commands.addWidget(sign_in)
    commands.addWidget(replace_button)
    commands.addWidget(delete_button)
    commands.addWidget(cancel_login)
    commands.addStretch(1)
    layout.addLayout(commands)
    section = TokenEntrySection(texts)
    layout.addWidget(section)
    return PanelWidgets(
        ownership_label=ownership_label,
        status=status,
        sign_in=sign_in,
        replace_button=replace_button,
        delete_button=delete_button,
        cancel_login=cancel_login,
        section=section,
        layout=layout,
    )


def install_accelerators(widgets: PanelWidgets) -> None:
    """Give every command a keyboard accelerator for full keyboard use."""
    widgets.sign_in.setShortcut(QKeySequence("Alt+S"))
    widgets.replace_button.setShortcut(QKeySequence("Alt+R"))
    widgets.delete_button.setShortcut(QKeySequence("Alt+D"))
    widgets.cancel_login.setShortcut(QKeySequence("Alt+C"))
    widgets.section.save_button().setShortcut(QKeySequence("Alt+E"))
    widgets.section.confirm_replace_button().setShortcut(QKeySequence("Alt+Y"))
    widgets.section.confirm_delete_button().setShortcut(QKeySequence("Alt+X"))


def command_buttons(widgets: PanelWidgets) -> tuple[ActionButton, ...]:
    """Return every command in deterministic keyboard order."""
    return (
        widgets.sign_in,
        widgets.replace_button,
        widgets.delete_button,
        widgets.cancel_login,
        widgets.section.save_button(),
        widgets.section.confirm_replace_button(),
        widgets.section.confirm_delete_button(),
    )


def focus_order(widgets: PanelWidgets, *, pending: bool) -> tuple[QWidget, ...]:
    """Return the deterministic tab/focus order of the interactive surface."""
    ordered: list[QWidget] = [
        widgets.sign_in,
        widgets.replace_button,
        widgets.delete_button,
    ]
    if pending:
        ordered.append(widgets.cancel_login)
    ordered.append(widgets.section.token_editor())
    ordered.append(widgets.section.save_button())
    ordered.append(widgets.section.confirm_replace_button())
    ordered.append(widgets.section.confirm_delete_button())
    return tuple(ordered)


def rendered_texts(widgets: PanelWidgets, *, status: str) -> tuple[str, ...]:
    """Return every currently rendered text for no-redisplay assertions."""
    rendered: list[str] = [
        widgets.ownership_label.text(),
        status,
        *[button.text() for button in command_buttons(widgets)],
    ]
    return tuple(text for text in rendered if text)
