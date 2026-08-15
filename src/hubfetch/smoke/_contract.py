"""Shared constants, argument parsing, and pure smoke-contract helpers.

Todo 30 gates the portable archive against a fixed contract: AMD64 PE entry
points, isolated app data, source-independent imports, a disposable AskPass
credential cycle, required license/plugin/DLL inventory, and zero sentinel
bytes. This module holds the pure decision logic so the packaged smoke and the
offline pytest gate cannot drift apart; it imports neither Qt nor subprocess.
"""

from __future__ import annotations

import base64
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal, override

if TYPE_CHECKING:
    from collections.abc import Sequence

SMOKE_FLAG: Final = "--smoke-test"
CAPTURE_FLAG: Final = "--smoke-capture"
APP_DATA_ROOT_FLAG: Final = "--app-data-root"
SMOKE_JSON_FLAG: Final = "--smoke-json"

SENTINEL: Final = base64.b64decode("aGZfdGVzdF9zZWNyZXRfMTIz")
"""Security sentinel kept base64-encoded so the contiguous byte sequence never
appears inside the packaged archive, logs, or captured artifacts."""

_MACHINE_AMD64: Final = 0x8664
_MSDOS_HEADER_LEN: Final = 64

FORBIDDEN_BASENAMES: Final = frozenset(
    {"git.exe", "git-lfs.exe", "git-xet", "hf.exe", "hub.exe"}
)

REQUIRED_PACKAGE_ENTRIES: Final = (
    "HubFetch.exe",
    "HubFetchAskPass.exe",
    "licenses/LICENSE",
    "licenses/THIRD_PARTY_NOTICES.md",
    "licenses/qt/LGPL-3.0.txt",
    "licenses/qt/GPL-3.0.txt",
    "docs/qt-lgpl-compliance.md",
    "docs/help_url_template.conf",
    "resources/fonts/CascadiaMono.ttf",
    "resources/fonts/OFL.txt",
    "resources/icons/settings.svg",
    "resources/icons/LICENSE.md",
    "hubfetch/persistence/sql/001_initial.sql",
    "PySide6/plugins/platforms/qwindows.dll",
    "PySide6/plugins/imageformats/qgif.dll",
    "PySide6/plugins/imageformats/qico.dll",
    "PySide6/plugins/imageformats/qjpeg.dll",
    "PySide6/plugins/imageformats/qsvg.dll",
    "PySide6/plugins/tls/qschannelbackend.dll",
    "PySide6/plugins/iconengines/qsvgicon.dll",
    "PySide6/plugins/styles/qmodernwindowsstyle.dll",
    "PySide6/translations/qtbase_zh_CN.qm",
    "hubfetch/i18n/hubfetch_zh_CN.qm",
    "hubfetch/i18n/hubfetch_en_US.qm",
    "PySide6/Qt6Core.dll",
    "PySide6/Qt6Gui.dll",
    "PySide6/Qt6Widgets.dll",
    "PySide6/Qt6Svg.dll",
    "PySide6/Qt6Network.dll",
    "PySide6/Qt6OpenGL.dll",
    "PySide6/Qt6Xml.dll",
    "PySide6/Qt6DBus.dll",
    "PySide6/pyside6.abi3.dll",
    "shiboken6/shiboken6.abi3.dll",
)


@dataclass(frozen=True, slots=True)
class SmokeArgs:
    """Parsed smoke-invocation arguments."""

    mode: Literal["smoke", "capture"]
    app_data_root: Path
    capture_path: Path | None
    smoke_json: Path | None


@dataclass(frozen=True, slots=True)
class SmokeArgumentError(ValueError):
    """A malformed smoke invocation rejected at the argument boundary."""

    reason: str

    @override
    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True, slots=True)
class PackageScan:
    """Inventory and sentinel findings for the packaged archive tree."""

    ok: bool
    missing: tuple[str, ...]
    forbidden: tuple[str, ...]
    sentinel_files: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AskPassContractResult:
    """Outcome of the disposable AskPass credential cycle."""

    backend: str
    alias_created: bool
    username_outcome: bool
    password_outcome: bool
    token_matched: bool
    token_deleted: bool
    error: str | None


@dataclass(frozen=True, slots=True)
class SmokeResult:
    """Full headless smoke report serialized as the machine evidence JSON."""

    python_exe: str
    frozen: bool
    pe_architecture: str
    module_origins: dict[str, str]
    sys_path: tuple[str, ...]
    qt_platform: str
    fonts_registered: tuple[str, ...]
    settings_roundtrip: bool
    database_created: bool
    package_inventory_ok: bool
    missing_package_entries: tuple[str, ...]
    forbidden_package_entries: tuple[str, ...]
    sentinel_files: tuple[str, ...]
    askpass: AskPassContractResult | None
    errors: tuple[str, ...]

    def to_json(self) -> str:
        """Serialize deterministically for byte-comparable evidence."""
        return json.dumps(asdict(self), ensure_ascii=True, indent=2, sort_keys=True)

    @property
    def passed(self) -> bool:
        """Return whether every smoke contract succeeded without errors."""
        askpass_ok = (
            self.askpass is not None
            and self.askpass.alias_created
            and self.askpass.username_outcome
            and self.askpass.password_outcome
            and self.askpass.token_matched
            and self.askpass.token_deleted
            and self.askpass.error is None
        )
        return (
            self.frozen
            and self.pe_architecture == "amd64"
            and self.settings_roundtrip
            and self.database_created
            and self.package_inventory_ok
            and not self.errors
            and askpass_ok
        )


def pe_machine_type(data: bytes) -> int | None:
    """Return the COFF machine type of a PE header, or None for invalid input."""
    if len(data) < _MSDOS_HEADER_LEN or data[:2] != b"MZ":
        return None
    e_lfanew = int.from_bytes(data[0x3C:0x40], "little")
    if e_lfanew + 24 > len(data) or data[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
        return None
    return int.from_bytes(data[e_lfanew + 4 : e_lfanew + 6], "little")


def is_amd64_pe(data: bytes) -> bool:
    """Return whether the header declares the AMD64 machine type."""
    return pe_machine_type(data) == _MACHINE_AMD64


def contains_sentinel(data: bytes, sentinel: bytes = SENTINEL) -> bool:
    """Return whether one byte blob embeds the security sentinel."""
    return sentinel in data


def scan_tree_for_sentinel(root: Path, sentinel: bytes = SENTINEL) -> tuple[Path, ...]:
    """Return every file under ``root`` whose bytes embed the sentinel."""
    return tuple(
        path
        for path in root.rglob("*")
        if path.is_file() and contains_sentinel(path.read_bytes(), sentinel)
    )


def is_forbidden_package_path(path: str) -> bool:
    """Return whether a packaged path carries a banned binary, Git-Xet, or DB."""
    lowered = path.casefold()
    basename = lowered.rsplit("/", 1)[-1]
    if basename in FORBIDDEN_BASENAMES:
        return True
    if any(segment == "git-xet" for segment in lowered.split("/")):
        return True
    return lowered.endswith((".db", ".sqlite", ".sqlite3", ".wal"))


def _require_value(argv: list[str], index: int, flag: str) -> Path:
    """Read the value token following one value-taking flag."""
    if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
        raise SmokeArgumentError(reason=f"{flag} requires a value")
    return Path(argv[index + 1])


def parse_smoke_args(raw: Sequence[str]) -> SmokeArgs:
    """Parse the bounded smoke argv or raise a typed usage error."""
    argv = list(raw)
    mode: Literal["smoke", "capture"] | None = None
    app_data_root: Path | None = None
    capture_path: Path | None = None
    smoke_json: Path | None = None
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in (SMOKE_FLAG, CAPTURE_FLAG):
            if mode is not None:
                raise SmokeArgumentError(reason="smoke mode specified twice")
            mode = "smoke" if arg == SMOKE_FLAG else "capture"
            if arg == CAPTURE_FLAG:
                capture_path = _require_value(argv, index, CAPTURE_FLAG)
                index += 1
        elif arg == APP_DATA_ROOT_FLAG:
            app_data_root = _require_value(argv, index, APP_DATA_ROOT_FLAG)
            index += 1
        elif arg == SMOKE_JSON_FLAG:
            smoke_json = _require_value(argv, index, SMOKE_JSON_FLAG)
            index += 1
        else:
            raise SmokeArgumentError(reason=f"unrecognized smoke argument: {arg}")
        index += 1
    if mode is None:
        raise SmokeArgumentError(reason="missing --smoke-test or --smoke-capture")
    if app_data_root is None:
        raise SmokeArgumentError(reason="--app-data-root is required")
    if mode == "capture" and capture_path is None:
        raise SmokeArgumentError(reason="--smoke-capture requires an output PNG path")
    return SmokeArgs(
        mode=mode,
        app_data_root=app_data_root,
        capture_path=capture_path,
        smoke_json=smoke_json,
    )


def is_smoke_request(raw: Sequence[str]) -> bool:
    """Return whether the process arguments request a smoke mode."""
    return SMOKE_FLAG in raw or CAPTURE_FLAG in raw
