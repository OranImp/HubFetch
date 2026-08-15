"""Masked token entry and replace/delete confirmation section.

The auth panel's HubFetch-only path needs a masked token editor (never echoed),
an add/replace save command, and explicit replace/delete confirmations. This
module owns that transient section as one widget so the panel keeps only the
ownership readout and browser-flow wiring. The token value is passed straight
to the service seam and never rendered back into any widget.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QVBoxLayout,
    QWidget,
)

from hubfetch.ui import tokens
from hubfetch.ui.widgets.buttons import ActionButton

if TYPE_CHECKING:
    from hubfetch.credentials.models import CredentialAlias

    from .service import AuthPanelService
    from .texts import AuthTexts

__all__ = ["TokenEntrySection"]


@final
class TokenEntrySection(QWidget):
    """The masked token row plus its replace/delete confirmation row."""

    saved = Signal(object)
    """Emitted with the replaced alias (or the new alias) after a save."""

    deleted = Signal(object)
    """Emitted with the deleted alias after a confirmed delete."""

    changed = Signal(str)
    """Emitted with the announcement text after any token change."""

    __slots__: Final = (
        "_alias",
        "_confirm_delete",
        "_confirm_pending",
        "_confirm_replace",
        "_replace_mode",
        "_save_button",
        "_texts",
        "_token_editor",
        "_token_field",
        "_token_row",
    )
    _texts: AuthTexts
    _token_row: QWidget
    _token_field: QLabel
    _token_editor: QLineEdit
    _save_button: ActionButton
    _confirm_replace: ActionButton
    _confirm_delete: ActionButton
    _replace_mode: bool
    _confirm_pending: bool
    _alias: CredentialAlias | None

    def __init__(self, texts: AuthTexts) -> None:
        """Compose the masked token row and the confirmation row."""
        super().__init__()
        self._texts = texts
        self._replace_mode = False
        self._confirm_pending = False
        self._alias = None
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_SM)
        self._token_row = QWidget(self)
        row_layout = QHBoxLayout(self._token_row)
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(tokens.SPACE_SM)
        self._token_field = QLabel(texts.token_field_label)
        self._token_editor = QLineEdit()
        self._token_editor.setEchoMode(QLineEdit.EchoMode.Password)
        self._token_editor.setPlaceholderText(texts.token_placeholder)
        self._token_editor.setAccessibleName(texts.token_field_label)
        self._save_button = ActionButton(texts.save_token_command)
        row_layout.addWidget(self._token_field)
        row_layout.addWidget(self._token_editor, stretch=1)
        row_layout.addWidget(self._save_button)
        self._token_row.setVisible(False)
        layout.addWidget(self._token_row)
        confirm_row = QHBoxLayout()
        confirm_row.setSpacing(tokens.SPACE_SM)
        self._confirm_replace = ActionButton(texts.confirm_command)
        self._confirm_delete = ActionButton(texts.delete_command)
        confirm_row.addStretch(1)
        confirm_row.addWidget(self._confirm_replace)
        confirm_row.addWidget(self._confirm_delete)
        layout.addLayout(confirm_row)
        self._confirm_replace.setVisible(False)
        self._confirm_delete.setVisible(False)

    def token_editor(self) -> QLineEdit:
        """Return the masked token editor (never echoes stored values)."""
        return self._token_editor

    def save_button(self) -> ActionButton:
        """Return the save-token command."""
        return self._save_button

    def confirm_replace_button(self) -> ActionButton:
        """Return the confirm-replace command."""
        return self._confirm_replace

    def confirm_delete_button(self) -> ActionButton:
        """Return the confirm-delete command."""
        return self._confirm_delete

    def confirm_pending(self) -> bool:
        """Return whether a replace/delete confirmation is open."""
        return self._confirm_pending

    def current_alias(self) -> CredentialAlias | None:
        """Return the alias currently managed by this section."""
        return self._alias

    def bind_alias(self, alias: CredentialAlias) -> None:
        """Bind the HubFetch-only alias this section manages."""
        self._alias = alias

    def open_add(self) -> None:
        """Open the masked token row for a fresh manual token."""
        self._replace_mode = False
        self._token_editor.clear()
        self._token_row.setVisible(True)
        self._token_editor.setFocus(Qt.FocusReason.OtherFocusReason)

    def open_replace(self) -> None:
        """Open the masked token row in replace mode for the bound alias."""
        self._replace_mode = True
        self._token_editor.clear()
        self._token_row.setVisible(True)
        self._token_editor.setFocus(Qt.FocusReason.OtherFocusReason)

    def request_replace(self) -> None:
        """Open the replace confirmation surface."""
        self._confirm_pending = True
        self._confirm_replace.setVisible(True)
        self._confirm_delete.setVisible(False)
        self._save_button.setAccessibleName(self._texts.replace_confirm_message)

    def request_delete(self) -> None:
        """Open the delete confirmation surface."""
        self._confirm_pending = True
        self._confirm_delete.setVisible(True)
        self._confirm_replace.setVisible(False)
        self._save_button.setAccessibleName(self._texts.delete_confirm_message)

    def confirm_replace(self, alias: CredentialAlias) -> None:
        """Enter the masked token row in replace mode for the bound alias."""
        self._alias = alias
        self._confirm_pending = False
        self._confirm_replace.setVisible(False)
        self.open_replace()

    def cancel_confirmation(self) -> None:
        """Dismiss any open confirmation without calling the service."""
        self._confirm_pending = False
        self._confirm_replace.setVisible(False)
        self._confirm_delete.setVisible(False)

    def hide_entry(self) -> None:
        """Hide the token row and any open confirmation."""
        self._token_row.setVisible(False)
        self.cancel_confirmation()

    def save(self, service: AuthPanelService) -> None:
        """Store the entered token through the service without redisplaying it."""
        raw = self._token_editor.text().strip()
        if not raw:
            return
        alias = self._alias
        if self._replace_mode and alias is not None:
            service.replace_manual_token(alias, token=raw)
        elif alias is None:
            alias = service.add_manual_token(token=raw)
            self._alias = alias
        self._token_editor.clear()
        self.hide_entry()
        self.saved.emit(alias)
        announcement = (
            self._texts.announcement_replaced_format
            if self._replace_mode
            else self._texts.announcement_added_format
        )
        self.changed.emit(announcement)

    def confirm_delete(self, service: AuthPanelService) -> None:
        """Delete the bound alias after explicit confirmation."""
        alias = self._alias
        if alias is None:
            return
        service.delete_credential(alias)
        self._alias = None
        self.cancel_confirmation()
        self.deleted.emit(alias)
        self.changed.emit(self._texts.announcement_deleted_format)
