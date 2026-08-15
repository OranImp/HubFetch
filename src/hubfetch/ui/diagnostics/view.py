# noqa: SIZE_OK - one module must own the whole diagnostics surface: the
# bilingual vocabulary, the typed report model, seven categorized probe groups,
# the install-guidance copy action, and the user-selected support export;
# splitting it would scatter one cohesive report across modules.

"""Diagnostics work surface: categorized read-only probes and support export.

Composes storage, network, Git/Git-Xet, credential-helper, keyring, endpoint,
and application diagnostics into one typed report (plan:36). Recheck re-runs
every probe; install guidance is copyable display data (never auto-run); and
the user-selected support-bundle export fails closed on a denied path through
the typed :class:`SupportBundleError` boundary.
"""

from __future__ import annotations

import http.client
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Final, Protocol, final
from urllib.parse import urlsplit

from keyring.errors import KeyringError
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.config.paths import resolve_app_paths
from hubfetch.config.settings import Locale, ProxyMode, Settings
from hubfetch.credentials.port import CredentialBackendRejectedError
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.diagnostics.cache import (
    CacheEnvironment,
    HubCacheScan,
    resolve_cache_environment,
    scan_hub_cache,
)
from hubfetch.diagnostics.credential_helpers import (
    CredentialHelperChecker,
    CredentialHelperReport,
)
from hubfetch.diagnostics.disk import VolumeInfo, volume_info
from hubfetch.diagnostics.filesystem import (
    DirectoryProbe,
    DirectorySize,
    directory_size,
    probe_directory,
)
from hubfetch.diagnostics.git import (
    GIT_INSTALL_GUIDANCE,
    XET_INIT_GUIDANCE,
    XET_INSTALL_GUIDANCE,
    GitDependencyChecker,
    GitDependencyReport,
)
from hubfetch.diagnostics.support_bundle import (
    SupportBundleBuilder,
    SupportBundleError,
    SupportBundleResult,
    collect_versions,
)
from hubfetch.security.redaction import Redactor
from hubfetch.ui import tokens
from hubfetch.ui.cache.view import format_bytes
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.common import apply_panel, semantic_colors
from hubfetch.ui.widgets.labels import CaptionLabel
from hubfetch.ui.widgets.status import StatusPair, StatusSeverity

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from hubfetch.credentials.models import BackendIdentity
    from hubfetch.security.redaction import JsonValue


class TextClipboard(Protocol):
    """Structural clipboard seam satisfied by QClipboard and test doubles."""

    def setText(self, text: str) -> None:  # noqa: N802 - Qt API naming
        """Replace the clipboard contents with ``text``."""


__all__ = [
    "CATEGORY_KEYS",
    "DiagnosticCategory",
    "DiagnosticEntry",
    "DiagnosticsReport",
    "DiagnosticsView",
    "DiagnosticsViewTexts",
    "EndpointProbe",
    "probe_hf_endpoint",
]

CATEGORY_KEYS: Final = (
    "storage",
    "network",
    "git",
    "credentials",
    "keyring",
    "endpoint",
    "application",
)
"""Closed ordered set of diagnostic categories the report always renders."""

_ENDPOINT_URL: Final = "https://huggingface.co"
_ENDPOINT_TIMEOUT_S: Final = 5.0
_HTTP_OK_LIMIT: Final = 400
"""Any status below this bound counts as a reachable endpoint."""


@dataclass(frozen=True, slots=True)
class EndpointProbe:
    """Read-only reachability result for one Hugging Face endpoint."""

    url: str
    reachable: bool | None
    detail: str


@dataclass(frozen=True, slots=True)
class DiagnosticEntry:
    """One key/value row with a severity and display-only guidance."""

    key: str
    value: str
    severity: StatusSeverity
    guidance: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class DiagnosticCategory:
    """One categorized group of diagnostic entries."""

    key: str
    entries: tuple[DiagnosticEntry, ...]


@dataclass(frozen=True, slots=True)
class DiagnosticsReport:
    """The complete typed report produced by one Recheck."""

    categories: tuple[DiagnosticCategory, ...]
    refreshed_at: str


@dataclass(frozen=True, slots=True)
class DiagnosticsViewTexts:
    """Bilingual vocabulary for the Diagnostics surface, resolved by locale."""

    title: str
    recheck_command: str
    copy_guidance_command: str
    export_bundle_command: str
    export_error_title: str
    export_done_title: str
    category_titles: dict[str, str]
    entry_labels: dict[str, str]
    storage_symlink_ok: str
    storage_symlink_degraded: str
    unknown_value: str
    reachable_value: str
    unreachable_value: str

    @classmethod
    def for_locale(cls, locale: Locale) -> DiagnosticsViewTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return DiagnosticsViewTexts(
                title="Diagnostics",
                recheck_command="Recheck",
                copy_guidance_command="Copy install guidance",
                export_bundle_command="Export support bundle…",
                export_error_title="Support export failed",
                export_done_title="Support bundle exported",
                category_titles={
                    "storage": "Storage",
                    "network": "Network",
                    "git": "Git and Git-Xet",
                    "credentials": "Credential helpers",
                    "keyring": "Keyring",
                    "endpoint": "Endpoint",
                    "application": "Application",
                },
                entry_labels={
                    "hf_home": "HF_HOME",
                    "hub_cache": "HF_HUB_CACHE",
                    "xet_cache": "HF_XET_CACHE",
                    "hub_cache_state": "Hub cache state",
                    "hub_size": "Hub cache size",
                    "free_space": "Free space",
                    "symlink": "Symlink support",
                    "proxy_mode": "Proxy mode",
                    "manual_proxy_url": "Manual proxy URL",
                    "git_version": "Git version",
                    "xet_version": "Git-Xet version",
                    "git_state": "Dependency state",
                    "credential_helpers": "Credential helpers",
                    "gcm": "Git Credential Manager",
                    "helper_warning": "Helper warning",
                    "backend": "Keyring backend",
                    "endpoint_url": "Endpoint",
                    "endpoint_reachability": "Reachability",
                    "package": "Package",
                    "python": "Python",
                    "platform": "Platform",
                    "architecture": "Architecture",
                    "PySide6": "PySide6",
                    "huggingface_hub": "huggingface_hub",
                    "pydantic": "pydantic",
                    "keyring": "keyring",
                },
                storage_symlink_ok="Symlinks work",
                storage_symlink_degraded="Symlinks degraded",
                unknown_value="Unknown",
                reachable_value="Reachable",
                unreachable_value="Unreachable",
            )
        return DiagnosticsViewTexts(
            title="诊断",
            recheck_command="重新检查",
            copy_guidance_command="复制安装指引",
            export_bundle_command="导出支持包…",
            export_error_title="支持包导出失败",
            export_done_title="支持包已导出",
            category_titles={
                "storage": "存储",
                "network": "网络",
                "git": "Git 与 Git-Xet",
                "credentials": "凭据助手",
                "keyring": "密钥环",
                "endpoint": "端点",
                "application": "应用程序",
            },
            entry_labels={
                "hf_home": "HF_HOME",
                "hub_cache": "HF_HUB_CACHE",
                "xet_cache": "HF_XET_CACHE",
                "hub_cache_state": "Hub 缓存状态",
                "hub_size": "Hub 缓存大小",
                "free_space": "可用空间",
                "symlink": "符号链接支持",
                "proxy_mode": "代理模式",
                "manual_proxy_url": "手动代理 URL",
                "git_version": "Git 版本",
                "xet_version": "Git-Xet 版本",
                "git_state": "依赖状态",
                "credential_helpers": "凭据助手",
                "gcm": "Git Credential Manager",
                "helper_warning": "助手警告",
                "backend": "密钥环后端",
                "endpoint_url": "端点",
                "endpoint_reachability": "可达性",
                "package": "程序包",
                "python": "Python",
                "platform": "平台",
                "architecture": "架构",
                "PySide6": "PySide6",
                "huggingface_hub": "huggingface_hub",
                "pydantic": "pydantic",
                "keyring": "keyring",
            },
            storage_symlink_ok="符号链接可用",
            storage_symlink_degraded="符号链接能力受限",
            unknown_value="未知",
            reachable_value="可达",
            unreachable_value="不可达",
        )


def probe_hf_endpoint(
    url: str = _ENDPOINT_URL, *, timeout_seconds: float = _ENDPOINT_TIMEOUT_S
) -> EndpointProbe:
    """Probe one endpoint reachability with a bounded read-only request."""
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        return EndpointProbe(url=url, reachable=False, detail="unsupported scheme")
    host = parsed.hostname
    if host is None:
        return EndpointProbe(url=url, reachable=False, detail="missing host")
    if parsed.scheme == "https":
        connection = http.client.HTTPSConnection(host, timeout=timeout_seconds)
    else:
        connection = http.client.HTTPConnection(host, timeout=timeout_seconds)
    try:
        connection.request("HEAD", parsed.path or "/")
        response = connection.getresponse()
        status = response.status
    except (OSError, TimeoutError, http.client.HTTPException) as error:
        return EndpointProbe(url=url, reachable=False, detail=str(error))
    finally:
        connection.close()
    return EndpointProbe(
        url=url, reachable=status < _HTTP_OK_LIMIT, detail=f"HTTP {status}"
    )


def _default_keyring_provider() -> BackendIdentity:
    """Return the verified backend identity, raising on untrusted backends."""
    store = WindowsCredentialManagerStore()
    return store.backend_identity


@dataclass(frozen=True, slots=True)
class DiagnosticsOptions:
    """Injectable probe and export seams for the diagnostics surface."""

    environ: Mapping[str, str] | None = None
    git_checker: Callable[[], GitDependencyReport] | None = None
    credential_checker: Callable[[], CredentialHelperReport] | None = None
    keyring_provider: Callable[[], BackendIdentity] | None = None
    endpoint_probe: Callable[[], EndpointProbe] | None = None
    exporter: Callable[[Path], SupportBundleResult] | None = None
    path_dialog: Callable[[], Path | None] | None = None
    log_dir: Path | None = None


@final
class DiagnosticsView(QWidget):
    """Render seven categorized diagnostics with recheck and export commands."""

    __slots__: Final = (
        "_copy_guidance",
        "_credential_checker",
        "_endpoint_probe",
        "_environ",
        "_export",
        "_export_error",
        "_export_error_label",
        "_export_result",
        "_exporter",
        "_git_checker",
        "_keyring_provider",
        "_log_dir",
        "_panels",
        "_path_dialog",
        "_recheck",
        "_report",
        "_settings",
        "_texts",
        "_title",
    )
    _texts: DiagnosticsViewTexts
    _settings: Settings
    _environ: Mapping[str, str] | None
    _git_checker: Callable[[], GitDependencyReport]
    _credential_checker: Callable[[], CredentialHelperReport]
    _keyring_provider: Callable[[], BackendIdentity]
    _endpoint_probe: Callable[[], EndpointProbe]
    _exporter: Callable[[Path], SupportBundleResult]
    _path_dialog: Callable[[], Path | None]
    _log_dir: Path
    _report: DiagnosticsReport | None
    _export_result: SupportBundleResult | None
    _export_error: str | None
    _panels: dict[str, QFrame]
    _title: QLabel
    _recheck: ActionButton
    _copy_guidance: ActionButton
    _export: ActionButton
    _export_error_label: CaptionLabel

    def __init__(
        self,
        texts: DiagnosticsViewTexts,
        *,
        settings: Settings,
        options: DiagnosticsOptions | None = None,
    ) -> None:
        """Compose the categorized panels and the three command buttons."""
        super().__init__()
        self._texts = texts
        self._settings = settings
        self._configure_seams(options if options is not None else DiagnosticsOptions())
        self._report = None
        self._export_result = None
        self._export_error = None
        self._panels = {}
        self.setAccessibleName(texts.title)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        outer.setSpacing(tokens.SPACE_MD)
        self._title = QLabel(texts.title)
        title_font = self._title.font()
        title_font.setBold(True)
        self._title.setFont(title_font)
        outer.addWidget(self._title)
        outer.addWidget(self._build_body(), stretch=1)
        self._export_error_label = CaptionLabel("")
        self._export_error_label.setWordWrap(True)
        self._export_error_label.hide()
        outer.addWidget(self._export_error_label)
        commands, recheck, copy_guidance, export = self._build_command_row()
        self._recheck = recheck
        self._copy_guidance = copy_guidance
        self._export = export
        outer.addLayout(commands)
        colors = semantic_colors(self.palette())
        apply_panel(self, colors.border, colors.window)

    def _configure_seams(self, options: DiagnosticsOptions) -> None:
        """Resolve every injectable seam to its production default."""
        self._environ = options.environ
        git_checker = options.git_checker
        if git_checker is None:
            git_checker = GitDependencyChecker().check
        self._git_checker = git_checker
        credential_checker = options.credential_checker
        if credential_checker is None:
            credential_checker = CredentialHelperChecker().check
        self._credential_checker = credential_checker
        keyring_provider = options.keyring_provider
        if keyring_provider is None:
            keyring_provider = _default_keyring_provider
        self._keyring_provider = keyring_provider
        endpoint_probe = options.endpoint_probe
        if endpoint_probe is None:
            endpoint_probe = probe_hf_endpoint
        self._endpoint_probe = endpoint_probe
        exporter = options.exporter
        if exporter is None:
            exporter = self._build_support_bundle
        self._exporter = exporter
        path_dialog = options.path_dialog
        if path_dialog is None:
            path_dialog = self._default_path_dialog
        self._path_dialog = path_dialog
        log_dir = options.log_dir
        if log_dir is None:
            log_dir = _default_log_root()
        self._log_dir = log_dir

    def _build_body(self) -> QScrollArea:
        """Build the single scroll owner holding every category panel."""
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setMinimumSize(0, 0)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        content = QWidget()
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(tokens.SPACE_MD)
        for key in CATEGORY_KEYS:
            panel = self._build_category_panel(key)
            self._panels[key] = panel
            content_layout.addWidget(panel)
        content_layout.addStretch(1)
        scroll.setWidget(content)
        return scroll

    def _build_command_row(
        self,
    ) -> tuple[QHBoxLayout, ActionButton, ActionButton, ActionButton]:
        """Compose the Recheck, Copy guidance, and Export commands."""
        texts = self._texts
        recheck = ActionButton(texts.recheck_command)
        copy_guidance = ActionButton(texts.copy_guidance_command)
        export = ActionButton(texts.export_bundle_command)
        _ = recheck.clicked.connect(self.recheck)
        _ = copy_guidance.clicked.connect(self._on_copy_guidance)
        _ = export.clicked.connect(self.export_support_bundle)
        commands = QHBoxLayout()
        commands.setSpacing(tokens.SPACE_SM)
        commands.addWidget(recheck)
        commands.addWidget(copy_guidance)
        commands.addWidget(export)
        commands.addStretch(1)
        return commands, recheck, copy_guidance, export

    def recheck(self) -> DiagnosticsReport:
        """Run every categorized probe and render the typed report."""
        report = self._compose_report()
        self._report = report
        self._render(report)
        return report

    def current_report(self) -> DiagnosticsReport | None:
        """Return the latest report, or None before the first recheck."""
        return self._report

    def install_guidance_text(self) -> str:
        """Return the copyable non-elevated install guidance."""
        lines = [GIT_INSTALL_GUIDANCE, XET_INSTALL_GUIDANCE, XET_INIT_GUIDANCE]
        report = self._report
        if report is not None:
            for category in report.categories:
                for entry in category.entries:
                    lines.extend(entry.guidance)
        return "\n".join(dict.fromkeys(lines))

    def copy_install_guidance(self, clipboard: TextClipboard | None = None) -> str:
        """Copy the install guidance to the clipboard and return the text."""
        text = self.install_guidance_text()
        target = clipboard if clipboard is not None else QApplication.clipboard()
        target.setText(text)
        return text

    def export_support_bundle(self) -> SupportBundleResult | None:
        """Export through the user-selected path; surface typed errors."""
        self._export_error = None
        self._export_result = None
        self._export_error_label.hide()
        target = self._path_dialog()
        if target is None:
            return None
        try:
            result = self._exporter(target)
        except SupportBundleError as error:
            self._export_error = str(error)
            self._export_error_label.setText(
                f"{self._texts.export_error_title}: {error}"
            )
            self._export_error_label.show()
            return None
        self._export_result = result
        self._export_error_label.setText(
            f"{self._texts.export_done_title}: {result.target}"
        )
        self._export_error_label.show()
        return result

    def export_error(self) -> str | None:
        """Return the latest typed export failure, if any."""
        return self._export_error

    def recheck_button(self) -> ActionButton:
        """Return the Recheck command."""
        return self._recheck

    def copy_guidance_button(self) -> ActionButton:
        """Return the Copy install guidance command."""
        return self._copy_guidance

    def export_button(self) -> ActionButton:
        """Return the Export support bundle command."""
        return self._export

    def _compose_report(self) -> DiagnosticsReport:
        """Gather every categorized probe into one typed report."""
        environment = resolve_cache_environment(
            environ=self._environ, overrides=self._settings.cache_path_overrides
        )
        hub_scan = scan_hub_cache(environment.hub_cache)
        hub_probe = probe_directory(environment.hub_cache)
        hub_size = (
            directory_size(environment.hub_cache)
            if environment.hub_cache.is_dir()
            else None
        )
        volume = volume_info(environment.hub_cache)
        categories = (
            self._storage_category(environment, hub_scan, hub_probe, hub_size, volume),
            self._network_category(),
            self._git_category(),
            self._credentials_category(),
            self._keyring_category(),
            self._endpoint_category(),
            self._application_category(),
        )
        return DiagnosticsReport(
            categories=categories, refreshed_at=datetime.now(UTC).isoformat()
        )

    def _storage_category(
        self,
        environment: CacheEnvironment,
        hub_scan: HubCacheScan,
        hub_probe: DirectoryProbe | None,
        hub_size: DirectorySize | None,
        volume: VolumeInfo,
    ) -> DiagnosticCategory:
        """Build the storage category from read-only cache/disk probes."""
        texts = self._texts
        guidance: tuple[str, ...] = ()
        degraded = hub_probe is not None and hub_probe.symlink_degraded
        if degraded and hub_probe is not None and hub_probe.recovery_hint:
            guidance = (hub_probe.recovery_hint,)
        return DiagnosticCategory(
            key="storage",
            entries=(
                DiagnosticEntry(
                    key="hf_home",
                    value=str(environment.hf_home),
                    severity=StatusSeverity.INFO,
                ),
                DiagnosticEntry(
                    key="hub_cache",
                    value=str(environment.hub_cache),
                    severity=StatusSeverity.INFO,
                ),
                DiagnosticEntry(
                    key="xet_cache",
                    value=str(environment.xet_cache),
                    severity=StatusSeverity.INFO,
                ),
                DiagnosticEntry(
                    key="hub_cache_state",
                    value=self._hub_scan_value(hub_scan),
                    severity=self._hub_scan_severity(hub_scan),
                ),
                DiagnosticEntry(
                    key="hub_size",
                    value=(
                        format_bytes(hub_size.bytes_total)
                        if hub_size is not None and hub_size.bytes_total is not None
                        else texts.unknown_value
                    ),
                    severity=StatusSeverity.INFO,
                ),
                DiagnosticEntry(
                    key="free_space",
                    value=(
                        format_bytes(volume.free_bytes)
                        if volume.free_bytes is not None
                        else texts.unknown_value
                    ),
                    severity=StatusSeverity.INFO,
                ),
                DiagnosticEntry(
                    key="symlink",
                    value=(
                        texts.storage_symlink_degraded
                        if degraded
                        else texts.storage_symlink_ok
                    ),
                    severity=(
                        StatusSeverity.FAILED if degraded else StatusSeverity.INFO
                    ),
                    guidance=guidance,
                ),
            ),
        )

    def _network_category(self) -> DiagnosticCategory:
        """Report the proxy policy from settings without any network mutation."""
        entries = [
            DiagnosticEntry(
                key="proxy_mode",
                value=self._settings.proxy_mode.value,
                severity=StatusSeverity.INFO,
            )
        ]
        if self._settings.proxy_mode is ProxyMode.MANUAL:
            entries.append(
                DiagnosticEntry(
                    key="manual_proxy_url",
                    value=self._settings.manual_proxy_url,
                    severity=StatusSeverity.INFO,
                )
            )
        return DiagnosticCategory(key="network", entries=tuple(entries))

    def _git_category(self) -> DiagnosticCategory:
        """Probe system Git and Git-Xet through the read-only checker."""
        return DiagnosticCategory(
            key="git",
            entries=self._git_entries(self._git_checker()),
        )

    def _credentials_category(self) -> DiagnosticCategory:
        """Probe credential helpers and Git Credential Manager read-only."""
        return DiagnosticCategory(
            key="credentials",
            entries=self._credential_entries(self._credential_checker()),
        )

    def _keyring_category(self) -> DiagnosticCategory:
        """Report the verified keyring backend or the fail-closed rejection."""
        try:
            identity = self._keyring_provider()
        except (
            CredentialBackendRejectedError,
            KeyringError,
            RuntimeError,
        ) as error:
            return DiagnosticCategory(
                key="keyring",
                entries=(
                    DiagnosticEntry(
                        key="backend",
                        value=str(error),
                        severity=StatusSeverity.FAILED,
                    ),
                ),
            )
        return DiagnosticCategory(
            key="keyring",
            entries=(
                DiagnosticEntry(
                    key="backend",
                    value=f"{identity.module}.{identity.class_name}",
                    severity=StatusSeverity.INFO,
                ),
            ),
        )

    def _endpoint_category(self) -> DiagnosticCategory:
        """Probe endpoint reachability through the injected bounded probe."""
        probe = self._endpoint_probe()
        texts = self._texts
        if probe.reachable is None:
            severity = StatusSeverity.INFO
            value = texts.unknown_value
        elif probe.reachable:
            severity = StatusSeverity.INFO
            value = texts.reachable_value
        else:
            severity = StatusSeverity.FAILED
            value = texts.unreachable_value
        detail = f" ({probe.detail})" if probe.detail else ""
        return DiagnosticCategory(
            key="endpoint",
            entries=(
                DiagnosticEntry(
                    key="endpoint_url",
                    value=probe.url,
                    severity=StatusSeverity.INFO,
                ),
                DiagnosticEntry(
                    key="endpoint_reachability",
                    value=f"{value}{detail}",
                    severity=severity,
                ),
            ),
        )

    def _application_category(self) -> DiagnosticCategory:
        """Report the app, runtime, and dependency versions."""
        versions = collect_versions()
        return DiagnosticCategory(
            key="application",
            entries=tuple(
                DiagnosticEntry(
                    key=name,
                    value=str(value),
                    severity=StatusSeverity.INFO,
                )
                for name, value in versions.items()
            ),
        )

    def _hub_scan_value(self, scan: HubCacheScan) -> str:
        """Render one hub-cache scan state as display text."""
        texts = self._texts
        if scan.scanned:
            return f"{scan.repo_count} repos, {format_bytes(scan.size_on_disk)}"
        if scan.error is not None:
            return f"{texts.unknown_value}: {scan.error}"
        return texts.unknown_value

    def _hub_scan_severity(self, scan: HubCacheScan) -> StatusSeverity:
        """Map the hub-cache scan state onto a status severity."""
        if scan.scanned or scan.error is None:
            return StatusSeverity.INFO
        return StatusSeverity.FAILED

    def _git_entries(self, report: GitDependencyReport) -> tuple[DiagnosticEntry, ...]:
        """Map a Git dependency report onto typed entries."""
        texts = self._texts
        severity = (
            StatusSeverity.INFO
            if report.state.value == "ready"
            else StatusSeverity.FAILED
        )
        return (
            DiagnosticEntry(
                key="git_version",
                value=report.git_version or texts.unknown_value,
                severity=StatusSeverity.INFO,
            ),
            DiagnosticEntry(
                key="xet_version",
                value=report.xet.version or texts.unknown_value,
                severity=StatusSeverity.INFO,
            ),
            DiagnosticEntry(
                key="git_state",
                value=report.state.value,
                severity=severity,
                guidance=report.guidance,
            ),
        )

    def _credential_entries(
        self, report: CredentialHelperReport
    ) -> tuple[DiagnosticEntry, ...]:
        """Map a credential helper report onto typed entries."""
        texts = self._texts
        warning = report.warning
        severity = (
            StatusSeverity.FAILED
            if report.state.value == "plaintext_unsafe"
            else StatusSeverity.INFO
        )
        entries = [
            DiagnosticEntry(
                key="credential_helpers",
                value=report.state.value,
                severity=severity,
                guidance=report.guidance,
            )
        ]
        if warning is not None:
            entries.append(
                DiagnosticEntry(
                    key="helper_warning",
                    value=warning,
                    severity=StatusSeverity.FAILED,
                )
            )
        gcm_value = (
            report.gcm.version
            if report.gcm.version is not None
            else (report.gcm.executable or texts.unknown_value)
        )
        entries.append(
            DiagnosticEntry(
                key="gcm",
                value=gcm_value,
                severity=(
                    StatusSeverity.INFO
                    if report.gcm.state.value == "present"
                    else StatusSeverity.FAILED
                ),
            )
        )
        return tuple(entries)

    def _render(self, report: DiagnosticsReport) -> None:
        """Rebuild each category panel's rows from the typed report."""
        for category in report.categories:
            panel = self._panels[category.key]
            raw_layout = panel.layout()
            if not isinstance(raw_layout, QVBoxLayout):
                continue
            layout = raw_layout
            self._clear_layout(layout)
            title = QLabel(self._texts.category_titles[category.key])
            title_font = title.font()
            title_font.setWeight(QFont.Weight.DemiBold)
            title.setFont(title_font)
            layout.addWidget(title)
            for entry in category.entries:
                layout.addWidget(self._entry_row(entry))
            layout.addStretch(1)

    def _entry_row(self, entry: DiagnosticEntry) -> QWidget:
        """Render one diagnostic entry with its guidance below the value."""
        row = QWidget(self)
        layout = QVBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_XS)
        headline = QHBoxLayout()
        headline.setSpacing(tokens.SPACE_SM)
        key = CaptionLabel(self._texts.entry_labels.get(entry.key, entry.key))
        headline.addWidget(key)
        headline.addStretch(1)
        pair = StatusPair(entry.severity, entry.value)
        pair.setAccessibleName(entry.value)
        headline.addWidget(pair)
        layout.addLayout(headline)
        for guidance in entry.guidance:
            hint = CaptionLabel(guidance)
            hint.setWordWrap(True)
            layout.addWidget(hint)
        return row

    def _clear_layout(self, layout: QVBoxLayout) -> None:
        """Remove every item and child widget from a category layout."""
        while layout.count():
            item = layout.takeAt(0)
            if item is None:
                continue
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _build_category_panel(self, key: str) -> QFrame:
        """Create one bordered category panel tagged with its key."""
        panel = QFrame(self)
        panel.setFrameShape(QFrame.Shape.StyledPanel)
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(
            tokens.SPACE_MD, tokens.SPACE_MD, tokens.SPACE_MD, tokens.SPACE_MD
        )
        layout.setSpacing(tokens.SPACE_SM)
        _ = panel.setProperty("category", key)
        colors = semantic_colors(panel.palette())
        apply_panel(panel, colors.border, colors.window)
        return panel

    def _default_path_dialog(self) -> Path | None:
        """Ask the user for the support ZIP path through a native dialog."""
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        default_name = f"hubfetch-support-{timestamp}.zip"
        selected, _filter = QFileDialog.getSaveFileName(
            self, self._texts.export_bundle_command, default_name, "ZIP (*.zip)"
        )
        return Path(selected) if selected else None

    def _build_support_bundle(self, target: Path) -> SupportBundleResult:
        """Build the support ZIP from the current report through the allowlist."""
        report = self._report
        diagnostics: dict[str, JsonValue] = (
            _report_payload(report) if report is not None else {}
        )
        builder = SupportBundleBuilder(Redactor())
        return builder.build(
            target=target,
            settings=self._settings,
            diagnostics=diagnostics,
            log_dir=self._log_dir,
        )

    def _on_copy_guidance(self) -> None:
        """Copy the install guidance when the command fires."""
        _ = self.copy_install_guidance()


def _default_log_root() -> Path:
    """Resolve the application log root through the config path boundary."""
    return resolve_app_paths().log_root


def _report_payload(report: DiagnosticsReport) -> dict[str, JsonValue]:
    """Convert one typed report into a JSON-safe diagnostic payload."""
    return {
        "refreshed_at": report.refreshed_at,
        "categories": [
            {
                "key": category.key,
                "entries": [
                    {
                        "key": entry.key,
                        "value": entry.value,
                        "severity": entry.severity.value,
                        "guidance": list(entry.guidance),
                    }
                    for entry in category.entries
                ],
            }
            for category in report.categories
        ],
    }
