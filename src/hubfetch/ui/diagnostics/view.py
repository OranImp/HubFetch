"""Diagnostics work surface: categorized read-only probes and support export.

The page owns the categorized panel registry, the three command buttons, the
typed export state machine, and the public probe/export entry points. Probe
composition lives in :mod:`.categories`, rendering in :mod:`.rendering`,
install-guidance copy in :mod:`.guidance`, and bundle export in
:mod:`.export`; this module re-exports the surface's public contract.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final, final

from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.diagnostics.support_bundle import (
    SupportBundleError,
    SupportBundleResult,
)
from hubfetch.ui import tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.common import apply_panel, semantic_colors
from hubfetch.ui.widgets.labels import CaptionLabel

from . import categories, guidance, rendering
from . import export as export_ops
from .models import CATEGORY_KEYS, DiagnosticsReport, EndpointProbe
from .seams import DiagnosticsOptions, DiagnosticsSeams, resolve_seams
from .texts import DiagnosticsViewTexts

if TYPE_CHECKING:
    from pathlib import Path

    from hubfetch.config.settings import Settings
    from hubfetch.security.redaction import JsonValue

__all__ = [
    "CATEGORY_KEYS",
    "DiagnosticCategory",
    "DiagnosticEntry",
    "DiagnosticsOptions",
    "DiagnosticsReport",
    "DiagnosticsView",
    "DiagnosticsViewTexts",
    "EndpointProbe",
    "probe_hf_endpoint",
]

# Re-export the typed report model under the surface's public contract.
from .models import (
    DiagnosticCategory,
    DiagnosticEntry,
    probe_hf_endpoint,
)


@final
class DiagnosticsView(QWidget):
    """Render seven categorized diagnostics with recheck and export commands."""

    __slots__: Final = (
        "_copy_guidance",
        "_export",
        "_export_error",
        "_export_error_label",
        "_export_result",
        "_panels",
        "_recheck",
        "_report",
        "_seams",
        "_settings",
        "_texts",
        "_title",
    )
    _texts: DiagnosticsViewTexts
    _settings: Settings
    _seams: DiagnosticsSeams
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
        self._seams = resolve_seams(
            options,
            default_exporter=self._build_support_bundle,
            default_path_dialog=self._default_path_dialog,
        )

    def _build_body(self) -> QScrollArea:
        """Build the single scroll owner holding every category panel."""
        scroll, panels = rendering.build_body(self, CATEGORY_KEYS)
        self._panels = panels
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
        report = categories.compose_report(self._seams, self._texts, self._settings)
        self._report = report
        rendering.render_report(self._panels, self._texts, report)
        return report

    def current_report(self) -> DiagnosticsReport | None:
        """Return the latest report, or None before the first recheck."""
        return self._report

    def install_guidance_text(self) -> str:
        """Return the copyable non-elevated install guidance."""
        return guidance.install_guidance_text(self._report)

    def copy_install_guidance(
        self, clipboard: guidance.TextClipboard | None = None
    ) -> str:
        """Copy the install guidance to the clipboard and return the text."""
        text = self.install_guidance_text()
        guidance.copy_install_guidance(text, clipboard)
        return text

    def export_support_bundle(self) -> SupportBundleResult | None:
        """Export through the user-selected path; surface typed errors."""
        self._export_error = None
        self._export_result = None
        self._export_error_label.hide()
        target = self._seams.path_dialog()
        if target is None:
            return None
        try:
            result = self._seams.exporter(target)
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

    def _on_copy_guidance(self) -> None:
        """Copy the install guidance when the command fires."""
        _ = self.copy_install_guidance()

    def _default_path_dialog(self) -> Path | None:
        """Ask the user for the support ZIP path through a native dialog."""
        return export_ops.default_path_dialog(self, self._texts.export_bundle_command)

    def _build_support_bundle(self, target: Path) -> SupportBundleResult:
        """Build the support ZIP from the current report through the allowlist."""
        report = self._report
        diagnostics: dict[str, JsonValue] = (
            export_ops.report_payload(report) if report is not None else {}
        )
        return export_ops.build_support_bundle(
            target=target,
            settings=self._settings,
            diagnostics=diagnostics,
            log_dir=self._seams.log_dir,
        )
