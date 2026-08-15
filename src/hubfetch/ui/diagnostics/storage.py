"""Storage diagnostic category: cache/disk probes rendered as entries.

``storage_category`` is the largest single category: it turns the effective
cache environment, hub-cache scan, directory probe, directory size, and volume
info into one typed category. The scan-value and severity render helpers live
beside it because no other category reads them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from hubfetch.ui.cache.view import format_bytes
from hubfetch.ui.widgets.status import StatusSeverity

from .models import DiagnosticCategory, DiagnosticEntry

if TYPE_CHECKING:
    from hubfetch.diagnostics.cache import CacheEnvironment, HubCacheScan
    from hubfetch.diagnostics.disk import VolumeInfo
    from hubfetch.diagnostics.filesystem import DirectoryProbe, DirectorySize

    from .texts import DiagnosticsViewTexts

__all__ = ["StorageProbes", "storage_category"]


@dataclass(frozen=True, slots=True)
class StorageProbes:
    """The read-only storage probes feeding the storage category."""

    environment: CacheEnvironment
    hub_scan: HubCacheScan
    hub_probe: DirectoryProbe | None
    hub_size: DirectorySize | None
    volume: VolumeInfo


def storage_category(
    texts: DiagnosticsViewTexts, probes: StorageProbes
) -> DiagnosticCategory:
    """Build the storage category from read-only cache/disk probes."""
    guidance: tuple[str, ...] = ()
    degraded = probes.hub_probe is not None and probes.hub_probe.symlink_degraded
    if degraded and probes.hub_probe is not None and probes.hub_probe.recovery_hint:
        guidance = (probes.hub_probe.recovery_hint,)
    return DiagnosticCategory(
        key="storage",
        entries=(
            DiagnosticEntry(
                key="hf_home",
                value=str(probes.environment.hf_home),
                severity=StatusSeverity.INFO,
            ),
            DiagnosticEntry(
                key="hub_cache",
                value=str(probes.environment.hub_cache),
                severity=StatusSeverity.INFO,
            ),
            DiagnosticEntry(
                key="xet_cache",
                value=str(probes.environment.xet_cache),
                severity=StatusSeverity.INFO,
            ),
            DiagnosticEntry(
                key="hub_cache_state",
                value=hub_scan_value(texts, probes.hub_scan),
                severity=hub_scan_severity(probes.hub_scan),
            ),
            DiagnosticEntry(
                key="hub_size",
                value=(
                    format_bytes(probes.hub_size.bytes_total)
                    if probes.hub_size is not None
                    and probes.hub_size.bytes_total is not None
                    else texts.unknown_value
                ),
                severity=StatusSeverity.INFO,
            ),
            DiagnosticEntry(
                key="free_space",
                value=(
                    format_bytes(probes.volume.free_bytes)
                    if probes.volume.free_bytes is not None
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
                severity=StatusSeverity.FAILED if degraded else StatusSeverity.INFO,
                guidance=guidance,
            ),
        ),
    )


def hub_scan_value(texts: DiagnosticsViewTexts, scan: HubCacheScan) -> str:
    """Render one hub-cache scan state as display text."""
    if scan.scanned:
        return f"{scan.repo_count} repos, {format_bytes(scan.size_on_disk)}"
    if scan.error is not None:
        return f"{texts.unknown_value}: {scan.error}"
    return texts.unknown_value


def hub_scan_severity(scan: HubCacheScan) -> StatusSeverity:
    """Map the hub-cache scan state onto a status severity."""
    if scan.scanned or scan.error is None:
        return StatusSeverity.INFO
    return StatusSeverity.FAILED
