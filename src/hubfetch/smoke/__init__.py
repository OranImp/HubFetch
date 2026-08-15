"""Portable smoke-test entry for the packaged HubFetch archive.

``HubFetch.exe --smoke-test --app-data-root <dir>`` (windowed entry, dispatched
from ``hubfetch.app.main``) bootstraps configuration, migrations, Qt resources,
and fonts without network or GUI interaction, exercises the disposable AskPass
credential contract, inspects its own PE architecture, package inventory,
import origins, and sentinel absence, and writes a machine-readable report.
``--smoke-capture <png>`` launches the real Tasks shell offscreen and captures
the empty shell. The pure contract helpers are shared with the offline pytest
gate so the package smoke and the tests cannot drift apart.
"""

from __future__ import annotations

# Importing the Qt-backed runner first initializes PySide6's signature loader
# before keyring/pydantic load, avoiding a cold-start shibokensupport cycle.
from ._runner import main, run_capture, run_smoke  # isort: skip

from ._askpass import AskPassSpawner, SpawnResult, run_askpass_contract
from ._contract import (
    APP_DATA_ROOT_FLAG,
    CAPTURE_FLAG,
    FORBIDDEN_BASENAMES,
    REQUIRED_PACKAGE_ENTRIES,
    SENTINEL,
    SMOKE_FLAG,
    SMOKE_JSON_FLAG,
    AskPassContractResult,
    PackageScan,
    SmokeArgs,
    SmokeArgumentError,
    SmokeResult,
    contains_sentinel,
    is_amd64_pe,
    is_forbidden_package_path,
    is_smoke_request,
    parse_smoke_args,
    pe_machine_type,
    scan_tree_for_sentinel,
)

__all__ = [
    "APP_DATA_ROOT_FLAG",
    "CAPTURE_FLAG",
    "FORBIDDEN_BASENAMES",
    "REQUIRED_PACKAGE_ENTRIES",
    "SENTINEL",
    "SMOKE_FLAG",
    "SMOKE_JSON_FLAG",
    "AskPassContractResult",
    "AskPassSpawner",
    "PackageScan",
    "SmokeArgs",
    "SmokeArgumentError",
    "SmokeResult",
    "SpawnResult",
    "contains_sentinel",
    "is_amd64_pe",
    "is_forbidden_package_path",
    "is_smoke_request",
    "main",
    "parse_smoke_args",
    "pe_machine_type",
    "run_askpass_contract",
    "run_capture",
    "run_smoke",
    "scan_tree_for_sentinel",
]
