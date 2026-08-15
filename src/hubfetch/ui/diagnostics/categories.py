"""Per-category probe sections for the Diagnostics report.

Each function in this module turns one read-only probe result (or settings
snapshot) into a typed :class:`DiagnosticCategory`. ``compose_report`` gathers
all seven categories in their fixed order and stamps the refresh timestamp;
the storage category lives in :mod:`.storage`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from keyring.errors import KeyringError

from hubfetch.config.settings import ProxyMode, Settings
from hubfetch.credentials.port import CredentialBackendRejectedError
from hubfetch.diagnostics.cache import (
    resolve_cache_environment,
    scan_hub_cache,
)
from hubfetch.diagnostics.disk import volume_info
from hubfetch.diagnostics.filesystem import (
    directory_size,
    probe_directory,
)
from hubfetch.diagnostics.support_bundle import collect_versions
from hubfetch.ui.widgets.status import StatusSeverity

from .models import (
    DiagnosticCategory,
    DiagnosticEntry,
    DiagnosticsReport,
    EndpointProbe,
)
from .storage import StorageProbes, storage_category

if TYPE_CHECKING:
    from collections.abc import Callable

    from hubfetch.credentials.models import BackendIdentity
    from hubfetch.diagnostics.credential_helpers import CredentialHelperReport
    from hubfetch.diagnostics.git import GitDependencyReport

    from .seams import DiagnosticsSeams
    from .texts import DiagnosticsViewTexts

__all__ = ["compose_report"]


def compose_report(
    seams: DiagnosticsSeams,
    texts: DiagnosticsViewTexts,
    settings: Settings,
) -> DiagnosticsReport:
    """Gather every categorized probe into one typed report."""
    environment = resolve_cache_environment(
        environ=seams.environ, overrides=settings.cache_path_overrides
    )
    hub_scan = scan_hub_cache(environment.hub_cache)
    hub_probe = probe_directory(environment.hub_cache)
    hub_size = (
        directory_size(environment.hub_cache)
        if environment.hub_cache.is_dir()
        else None
    )
    volume = volume_info(environment.hub_cache)
    return DiagnosticsReport(
        categories=(
            storage_category(
                texts,
                StorageProbes(
                    environment=environment,
                    hub_scan=hub_scan,
                    hub_probe=hub_probe,
                    hub_size=hub_size,
                    volume=volume,
                ),
            ),
            network_category(settings),
            git_category(texts, seams.git_checker()),
            credentials_category(texts, seams.credential_checker()),
            keyring_category(seams.keyring_provider),
            endpoint_category(texts, seams.endpoint_probe()),
            application_category(),
        ),
        refreshed_at=datetime.now(UTC).isoformat(),
    )


def network_category(settings: Settings) -> DiagnosticCategory:
    """Report the proxy policy from settings without any network mutation."""
    entries = [
        DiagnosticEntry(
            key="proxy_mode",
            value=settings.proxy_mode.value,
            severity=StatusSeverity.INFO,
        )
    ]
    if settings.proxy_mode is ProxyMode.MANUAL:
        entries.append(
            DiagnosticEntry(
                key="manual_proxy_url",
                value=settings.manual_proxy_url,
                severity=StatusSeverity.INFO,
            )
        )
    return DiagnosticCategory(key="network", entries=tuple(entries))


def git_category(
    texts: DiagnosticsViewTexts, report: GitDependencyReport
) -> DiagnosticCategory:
    """Probe system Git and Git-Xet through the read-only checker."""
    return DiagnosticCategory(key="git", entries=git_entries(texts, report))


def credentials_category(
    texts: DiagnosticsViewTexts, report: CredentialHelperReport
) -> DiagnosticCategory:
    """Probe credential helpers and Git Credential Manager read-only."""
    return DiagnosticCategory(
        key="credentials", entries=credential_entries(texts, report)
    )


def keyring_category(
    provider: Callable[[], BackendIdentity],
) -> DiagnosticCategory:
    """Report the verified keyring backend or the fail-closed rejection."""
    try:
        identity = provider()
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


def endpoint_category(
    texts: DiagnosticsViewTexts, probe: EndpointProbe
) -> DiagnosticCategory:
    """Probe endpoint reachability through the injected bounded probe."""
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


def application_category() -> DiagnosticCategory:
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


def git_entries(
    texts: DiagnosticsViewTexts, report: GitDependencyReport
) -> tuple[DiagnosticEntry, ...]:
    """Map a Git dependency report onto typed entries."""
    severity = (
        StatusSeverity.INFO if report.state.value == "ready" else StatusSeverity.FAILED
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


def credential_entries(
    texts: DiagnosticsViewTexts, report: CredentialHelperReport
) -> tuple[DiagnosticEntry, ...]:
    """Map a credential helper report onto typed entries."""
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
