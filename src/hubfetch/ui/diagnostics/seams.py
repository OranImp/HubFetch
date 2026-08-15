"""Injectable probe and export seams for the Diagnostics surface.

``DiagnosticsOptions`` is the public input contract the view accepts; the
frozen :class:`DiagnosticsSeams` is the resolved production wiring. Probe seams
default to the real read-only checkers while export/path seams default to the
view's own bound helpers (they carry the current report and settings).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from hubfetch.config.paths import resolve_app_paths
from hubfetch.credentials.windows_keyring import WindowsCredentialManagerStore
from hubfetch.diagnostics.credential_helpers import (
    CredentialHelperChecker,
    CredentialHelperReport,
)
from hubfetch.diagnostics.git import GitDependencyChecker, GitDependencyReport

from .models import EndpointProbe, probe_hf_endpoint

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping
    from pathlib import Path

    from hubfetch.credentials.models import BackendIdentity
    from hubfetch.diagnostics.support_bundle import SupportBundleResult

__all__ = ["DiagnosticsOptions", "DiagnosticsSeams", "resolve_seams"]


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


@dataclass(frozen=True, slots=True)
class DiagnosticsSeams:
    """The resolved production seams used by every diagnostics probe."""

    environ: Mapping[str, str] | None
    git_checker: Callable[[], GitDependencyReport]
    credential_checker: Callable[[], CredentialHelperReport]
    keyring_provider: Callable[[], BackendIdentity]
    endpoint_probe: Callable[[], EndpointProbe]
    exporter: Callable[[Path], SupportBundleResult]
    path_dialog: Callable[[], Path | None]
    log_dir: Path


def _default_keyring_provider() -> BackendIdentity:
    """Return the verified backend identity, raising on untrusted backends."""
    store = WindowsCredentialManagerStore()
    return store.backend_identity


def resolve_seams(
    options: DiagnosticsOptions,
    *,
    default_exporter: Callable[[Path], SupportBundleResult],
    default_path_dialog: Callable[[], Path | None],
) -> DiagnosticsSeams:
    """Resolve every injectable seam to its production default."""
    git_checker = options.git_checker
    if git_checker is None:
        git_checker = GitDependencyChecker().check
    credential_checker = options.credential_checker
    if credential_checker is None:
        credential_checker = CredentialHelperChecker().check
    keyring_provider = options.keyring_provider
    if keyring_provider is None:
        keyring_provider = _default_keyring_provider
    endpoint_probe = options.endpoint_probe
    if endpoint_probe is None:
        endpoint_probe = probe_hf_endpoint
    exporter = options.exporter
    if exporter is None:
        exporter = default_exporter
    path_dialog = options.path_dialog
    if path_dialog is None:
        path_dialog = default_path_dialog
    log_dir = options.log_dir
    if log_dir is None:
        log_dir = resolve_app_paths().log_root
    return DiagnosticsSeams(
        environ=options.environ,
        git_checker=git_checker,
        credential_checker=credential_checker,
        keyring_provider=keyring_provider,
        endpoint_probe=endpoint_probe,
        exporter=exporter,
        path_dialog=path_dialog,
        log_dir=log_dir,
    )
