"""Support-bundle export controls for the Diagnostics surface.

Owns the user-selected ZIP path dialog, the allowlisted bundle builder, and
the JSON-safe report payload conversion. The view keeps the typed export state
machine (path selection, typed-error surfacing, done/error labels); this module
holds the pure export construction.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from PySide6.QtWidgets import QFileDialog, QWidget

from hubfetch.config.paths import resolve_app_paths
from hubfetch.diagnostics.support_bundle import (
    SupportBundleBuilder,
    SupportBundleResult,
)
from hubfetch.security.redaction import Redactor

if TYPE_CHECKING:
    from hubfetch.config.settings import Settings
    from hubfetch.security.redaction import JsonValue

    from .models import DiagnosticsReport

__all__ = [
    "build_support_bundle",
    "default_log_root",
    "default_path_dialog",
    "report_payload",
]


def default_log_root() -> Path:
    """Resolve the application log root through the config path boundary."""
    return resolve_app_paths().log_root


def default_path_dialog(parent: QWidget, command_text: str) -> Path | None:
    """Ask the user for the support ZIP path through a native dialog."""
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    default_name = f"hubfetch-support-{timestamp}.zip"
    selected, _filter = QFileDialog.getSaveFileName(
        parent, command_text, default_name, "ZIP (*.zip)"
    )
    return Path(selected) if selected else None


def build_support_bundle(
    target: Path,
    *,
    settings: Settings,
    diagnostics: dict[str, JsonValue],
    log_dir: Path,
) -> SupportBundleResult:
    """Build the support ZIP from the given payload through the allowlist."""
    builder = SupportBundleBuilder(Redactor())
    return builder.build(
        target=target,
        settings=settings,
        diagnostics=diagnostics,
        log_dir=log_dir,
    )


def report_payload(report: DiagnosticsReport) -> dict[str, JsonValue]:
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
