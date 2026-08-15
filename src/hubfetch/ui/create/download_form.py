"""The typed Download creation form body: fields, dependencies, inline errors.

# noqa: SIZE_OK - one form must own the whole download input surface: the file
# vs snapshot mode, cache vs local destination, manual proxy dependency, the
# browse command, and the inline error rendering for every field.

The form is the input surface only: it captures raw values, enforces the field
dependencies (file vs snapshot, cache vs local, manual proxy visibility), and
renders inline errors supplied by the dialog. It never plans, never talks to a
service, and emits ``changed`` whenever any input moves so the dialog can
invalidate a stale plan.
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

from .contracts import ConflictChoice, DestinationChoice, DownloadMode, FieldError
from .fields import LabeledCombo, PatternField
from .validation import DownloadValues

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from .texts import CreateTexts

    DirectoryPicker = Callable[[str], str]


@final
class DownloadForm(QWidget):
    """One transient download form with typed field dependencies."""

    changed: Signal = Signal()

    __slots__: Final = (
        "_auth",
        "_conflict",
        "_destination",
        "_directory_picker",
        "_exclude",
        "_filename",
        "_include",
        "_local",
        "_local_browse",
        "_mode",
        "_proxy",
        "_proxy_url",
        "_repo_id",
        "_repo_kind",
        "_revision",
        "_texts",
    )
    _texts: CreateTexts
    _directory_picker: DirectoryPicker
    _mode: SegmentedControl
    _repo_kind: RepositoryTypeSelector
    _repo_id: TextField
    _revision: RevisionField
    _filename: TextField
    _include: PatternField
    _exclude: PatternField
    _destination: SegmentedControl
    _local: PathField
    _local_browse: ActionButton
    _conflict: LabeledCombo
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
        self._mode = SegmentedControl(
            texts.mode_label,
            (
                Segment(DownloadMode.FILE.value, texts.mode_file),
                Segment(DownloadMode.SNAPSHOT.value, texts.mode_snapshot),
            ),
        )
        layout.addWidget(self._mode)
        self._repo_kind = RepositoryTypeSelector(texts.repo_type_label)
        layout.addWidget(self._repo_kind)
        self._repo_id = TextField(
            texts.repo_id_label, placeholder=texts.repo_id_placeholder
        )
        layout.addWidget(self._repo_id)
        self._revision = RevisionField(
            texts.revision_label, placeholder=texts.revision_placeholder
        )
        layout.addWidget(self._revision)
        self._filename = TextField(
            texts.filename_label, placeholder=texts.filename_placeholder
        )
        layout.addWidget(self._filename)
        self._include = PatternField(
            texts.include_label, placeholder=texts.include_placeholder
        )
        self._exclude = PatternField(
            texts.exclude_label, placeholder=texts.exclude_placeholder
        )
        layout.addWidget(self._include)
        layout.addWidget(self._exclude)
        self._destination = SegmentedControl(
            texts.destination_label,
            (
                Segment(DestinationChoice.CACHE.value, texts.dest_cache),
                Segment(DestinationChoice.LOCAL.value, texts.dest_local),
            ),
        )
        layout.addWidget(self._destination)
        destination_row = QHBoxLayout()
        destination_row.setSpacing(tokens.SPACE_SM)
        self._local = PathField(texts.local_path_label)
        self._local_browse = ActionButton(texts.browse_label)
        destination_row.addWidget(self._local, stretch=1)
        destination_row.addWidget(self._local_browse)
        layout.addLayout(destination_row)
        self._conflict = LabeledCombo(
            texts.conflict_label,
            (
                (ConflictChoice.OVERWRITE.value, texts.conflict_overwrite),
                (ConflictChoice.PRESERVE.value, texts.conflict_preserve),
                (ConflictChoice.FAIL.value, texts.conflict_fail),
            ),
        )
        layout.addWidget(self._conflict)
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

    def values(self) -> DownloadValues:
        """Return the raw field values as one typed dataclass."""
        return DownloadValues(
            mode=DownloadMode(self._mode.current_key()),
            repo_kind=self._repo_kind.current_choice(),
            repo_id=self._repo_id.editor().text().strip(),
            revision=self._revision.editor().text().strip(),
            filename=self._filename.editor().text().strip(),
            include_patterns=self._include.text(),
            exclude_patterns=self._exclude.text(),
            destination=DestinationChoice(self._destination.current_key()),
            local_path=self._local.editor().text(),
            conflict_policy=ConflictChoice(self._conflict.current_key()),
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
        self._revision.set_error(by_field.get("revision"))
        self._filename.set_error(by_field.get("filename"))
        self._include.set_error(by_field.get("patterns"))
        self._exclude.set_error(by_field.get("patterns"))
        self._local.set_error(by_field.get("destination"))
        self._proxy_url.set_error(by_field.get("proxy"))

    def mode_segments(self) -> SegmentedControl:
        """Expose the file/snapshot segmented control."""
        return self._mode

    def repo_kind_selector(self) -> RepositoryTypeSelector:
        """Expose the repository-type selector."""
        return self._repo_kind

    def repo_id_field(self) -> TextField:
        """Expose the repository identifier field."""
        return self._repo_id

    def revision_field(self) -> RevisionField:
        """Expose the optional revision field."""
        return self._revision

    def filename_field(self) -> TextField:
        """Expose the remote filename field (file mode only)."""
        return self._filename

    def include_field(self) -> PatternField:
        """Expose the include-patterns field (snapshot mode only)."""
        return self._include

    def exclude_field(self) -> PatternField:
        """Expose the exclude-patterns field (snapshot mode only)."""
        return self._exclude

    def destination_segments(self) -> SegmentedControl:
        """Expose the cache/local segmented control."""
        return self._destination

    def local_path_field(self) -> PathField:
        """Expose the local destination path field."""
        return self._local

    def browse_button(self) -> ActionButton:
        """Expose the native directory browse command."""
        return self._local_browse

    def conflict_combo(self) -> LabeledCombo:
        """Expose the download conflict-policy selector."""
        return self._conflict

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
        self._mode.currentChanged.connect(self._on_changed)
        self._repo_kind.combo().currentIndexChanged.connect(self._on_changed)
        self._repo_id.editor().textChanged.connect(self._on_changed)
        self._revision.editor().textChanged.connect(self._on_changed)
        self._filename.editor().textChanged.connect(self._on_changed)
        self._include.editor().textChanged.connect(self._on_changed)
        self._exclude.editor().textChanged.connect(self._on_changed)
        self._destination.currentChanged.connect(self._on_changed)
        self._local.editor().textChanged.connect(self._on_changed)
        self._conflict.combo().currentIndexChanged.connect(self._on_changed)
        self._auth.combo().currentIndexChanged.connect(self._on_changed)
        self._proxy.combo().currentIndexChanged.connect(self._on_changed)
        self._proxy_url.editor().textChanged.connect(self._on_changed)
        self._local_browse.clicked.connect(self._on_browse)

    def _on_changed(self, *_args: object) -> None:
        """Re-apply field dependencies and announce the input change."""
        self._apply_dependencies()
        self.changed.emit()

    def _on_browse(self) -> None:
        """Open the native directory picker and load its selection, if any."""
        selected = self._directory_picker(self._texts.local_path_label)
        if selected:
            self._local.set_text(selected)
            self._on_changed()

    def _apply_dependencies(self) -> None:
        """Show file or snapshot fields per mode, local per destination, proxy URL."""
        is_file = DownloadMode(self._mode.current_key()) is DownloadMode.FILE
        self._filename.setVisible(is_file)
        self._include.setVisible(not is_file)
        self._exclude.setVisible(not is_file)
        is_local = (
            DestinationChoice(self._destination.current_key())
            is DestinationChoice.LOCAL
        )
        self._local.setVisible(is_local)
        self._local_browse.setVisible(is_local)
        is_manual = ProxyMode(self._proxy.current_key()) is ProxyMode.MANUAL
        self._proxy_url.setVisible(is_manual)

    @staticmethod
    def _native_directory_picker(title: str) -> str:
        """Open the native directory dialog and return the selection, if any."""
        return QFileDialog.getExistingDirectory(None, title)


__all__ = ["DownloadForm"]
