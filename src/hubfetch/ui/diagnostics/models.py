"""Typed report model and read-only endpoint probe for Diagnostics.

Owns the closed category keys, the endpoint probe constants, the four frozen
report dataclasses, and the bounded reachability probe. The DiagnosticsView
and every per-category builder import these shapes from this one module.
"""

from __future__ import annotations

import http.client
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final
from urllib.parse import urlsplit

if TYPE_CHECKING:
    from hubfetch.ui.widgets.status import StatusSeverity

__all__ = [
    "CATEGORY_KEYS",
    "DiagnosticCategory",
    "DiagnosticEntry",
    "DiagnosticsReport",
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
