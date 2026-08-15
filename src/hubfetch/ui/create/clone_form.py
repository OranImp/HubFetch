"""The typed Clone creation form body: transport, fields, inline errors.

The form captures raw clone inputs: an HTTPS repo reference or a validated SSH
URL, an optional branch/tag revision, an optional shallow flag, an empty-or-
absent destination, auth source, and proxy mode. It enforces the transport and
proxy field dependencies, never preflights, and emits ``changed`` so the dialog
can invalidate a stale preflight.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QFileDialog, QHBoxLayout, QVBoxLayout, QWidget

from hubfetch.domain.task_spec import AuthSource, ProxyMode
from hubfetch.ui import tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.fields import PathField, ProxyField, RevisionField, TextField
from hubfetch.ui.widgets.segmented import Segment, SegmentedControl
from hubfetch.ui.widgets.selectors import RepositoryTypeSelector
from hubfetch.ui.widgets.toggles import CheckboxField

from .contracts import FieldError, TransportChoice
from .fields import LabeledCombo
from .validation import CloneValues

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from .texts import CreateTexts

    DirectoryPicker = Callable[[str], str]


@final
class CloneForm(QWidget):
    """One transient clone form with typed field dependencies."""

    changed: Signal = Signal()

    __slots__: Final = (
        "_auth",
        "_destination",
        "_directory_picker",
        "_proxy",
        "_proxy_url",
        "_repo_id",
        "_repo_kind",
        "_revision",
        "_shallow",
        "_ssh_url",
        "_texts",
        "_transport",
    )
    _texts: CreateTexts
    _directory_picker: DirectoryPicker
    _transport: SegmentedControl
    _repo_kind: RepositoryTypeSelector
    _repo_id: TextField
    _ssh_url: TextField
    _revision: RevisionField
    _shallow: CheckboxField
    _destination: PathField
    _browse: ActionButton
    _auth: LabeledCombo
    _proxy: LabeledCombo
    _proxy_url: ProxyField

    def __init__(
        self,
        texts: CreateTexts,
        *,
        directory_picker: DirectoryPicker | None = None,
    ) -> None:
        """Compose the fields in keyboard order with the injected directory picker."""
        super().__init__()
        self._texts = texts
        self._directory_picker = (
            directory_picker
            if directory_picker is not None
            else self._native_directory_picker
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_SM)
        self._transport = SegmentedControl(
            texts.transport_label,
            (
                Segment(TransportChoice.HTTPS.value, texts.transport_https),
                Segment(TransportChoice.SSH.value, texts.transport_ssh),
            ),
        )
        layout.addWidget(self._transport)
        self._repo_kind = RepositoryTypeSelector(texts.repo_type_label)
        layout.addWidget(self._repo_kind)
        self._repo_id = TextField(
            texts.repo_id_label, placeholder=texts.repo_id_placeholder
        )
        layout.addWidget(self._repo_id)
        self._ssh_url = TextField(
            texts.ssh_url_label, placeholder=texts.ssh_url_placeholder, mono=True
        )
        layout.addWidget(self._ssh_url)
        self._revision = RevisionField(
            texts.revision_label, placeholder=texts.revision_placeholder
        )
        layout.addWidget(self._revision)
        self._shallow = CheckboxField(texts.shallow_label, texts.shallow_description)
        layout.addWidget(self._shallow)
        destination_row = QHBoxLayout()
        destination_row.setSpacing(tokens.SPACE_SM)
        self._destination = PathField(
            texts.destination_label, placeholder=texts.destination_placeholder
        )
        self._browse = ActionButton(texts.browse_label)
        destination_row.addWidget(self._destination, stretch=1)
        destination_row.addWidget(self._browse)
        layout.addLayout(destination_row)
        self._auth = LabeledCombo(
            texts.auth_label,
            (
                (AuthSource.ANONYMOUS.value, texts.auth_anonymous),
                (AuthSource.SHARED_OAUTH.value, texts.auth_shared),
                (AuthSource.MANUAL_TOKEN.value, texts.auth_manual),
            ),
        )
        layout.addWidget(self._auth)
        self._proxy = LabeledCombo(
            texts.proxy_label,
            (
                (ProxyMode.SYSTEM.value, texts.proxy_system),
                (ProxyMode.DIRECT.value, texts.proxy_direct),
                (ProxyMode.MANUAL.value, texts.proxy_manual),
            ),
        )
        layout.addWidget(self._proxy)
        self._proxy_url = ProxyField(texts.proxy_url_label)
        layout.addWidget(self._proxy_url)
        self._connect()
        self._apply_dependencies()

    def values(self) -> CloneValues:
        """Return the raw field values as one typed dataclass."""
        return CloneValues(
            transport=TransportChoice(self._transport.current_key()),
            repo_kind=self._repo_kind.current_choice(),
            repo_id=self._repo_id.editor().text().strip(),
            ssh_url=self._ssh_url.editor().text().strip(),
            revision=self._revision.editor().text().strip(),
            shallow=self._shallow.box().isChecked(),
            destination=self._destination.editor().text(),
            auth_source=AuthSource(self._auth.current_key()),
            proxy_mode=ProxyMode(self._proxy.current_key()),
            manual_proxy_url=self._proxy_url.editor().text().strip(),
        )

    def set_field_errors(self, errors: Sequence[FieldError]) -> None:
        """Render one inline error per field; unaffected fields are cleared."""
        by_field: dict[str, str] = {}
        for error in errors:
            by_field[error.field] = self._texts.field_error(error.code)
        self._repo_id.set_error(by_field.get("repo_id"))
        self._ssh_url.set_error(by_field.get("ssh_url"))
        self._revision.set_error(by_field.get("revision"))
        self._destination.set_error(by_field.get("destination"))
        self._proxy_url.set_error(by_field.get("proxy"))

    def transport_segments(self) -> SegmentedControl:
        """Expose the HTTPS/SSH transport segmented control."""
        return self._transport

    def repo_kind_selector(self) -> RepositoryTypeSelector:
        """Expose the repository-type selector."""
        return self._repo_kind

    def repo_id_field(self) -> TextField:
        """Expose the repository identifier field (HTTPS mode only)."""
        return self._repo_id

    def ssh_url_field(self) -> TextField:
        """Expose the SSH URL field (SSH mode only)."""
        return self._ssh_url

    def revision_field(self) -> RevisionField:
        """Expose the optional branch/tag revision field."""
        return self._revision

    def shallow_field(self) -> CheckboxField:
        """Expose the shallow-clone checkbox."""
        return self._shallow

    def destination_field(self) -> PathField:
        """Expose the clone destination path field."""
        return self._destination

    def browse_button(self) -> ActionButton:
        """Expose the native directory browse command."""
        return self._browse

    def auth_combo(self) -> LabeledCombo:
        """Expose the authentication-source selector."""
        return self._auth

    def proxy_combo(self) -> LabeledCombo:
        """Expose the proxy-mode selector."""
        return self._proxy

    def proxy_url_field(self) -> ProxyField:
        """Expose the manual proxy URL field (manual mode only)."""
        return self._proxy_url

    def _connect(self) -> None:
        """Bind every input to the changed signal and the browse command."""
        self._transport.currentChanged.connect(self._on_changed)
        self._repo_kind.combo().currentIndexChanged.connect(self._on_changed)
        self._repo_id.editor().textChanged.connect(self._on_changed)
        self._ssh_url.editor().textChanged.connect(self._on_changed)
        self._revision.editor().textChanged.connect(self._on_changed)
        self._shallow.box().toggled.connect(self._on_changed)
        self._destination.editor().textChanged.connect(self._on_changed)
        self._auth.combo().currentIndexChanged.connect(self._on_changed)
        self._proxy.combo().currentIndexChanged.connect(self._on_changed)
        self._proxy_url.editor().textChanged.connect(self._on_changed)
        self._browse.clicked.connect(self._on_browse)

    def _on_changed(self, *_args: object) -> None:
        """Re-apply field dependencies and announce the input change."""
        self._apply_dependencies()
        self.changed.emit()

    def _on_browse(self) -> None:
        """Open the native directory picker and load its selection, if any."""
        selected = self._directory_picker(self._texts.destination_label)
        if selected:
            self._destination.set_text(selected)
            self._on_changed()

    def _apply_dependencies(self) -> None:
        """Show the repo id or SSH URL per transport and proxy URL per mode."""
        is_ssh = TransportChoice(self._transport.current_key()) is TransportChoice.SSH
        self._repo_id.setVisible(not is_ssh)
        self._ssh_url.setVisible(is_ssh)
        is_manual = ProxyMode(self._proxy.current_key()) is ProxyMode.MANUAL
        self._proxy_url.setVisible(is_manual)

    @staticmethod
    def _native_directory_picker(title: str) -> str:
        """Open the native directory dialog and return the selection, if any."""
        return QFileDialog.getExistingDirectory(None, title)


__all__ = ["CloneForm"]
