"""Qt-backed headless smoke and GUI capture runners for the portable archive.

``run_smoke`` boots configuration, migrations, the SQLite database, Qt
resources/plugins, and fonts with no network or GUI interaction, exercises the
AskPass contract, inspects its own PE architecture, package inventory, import
origins, and sentinel absence, then writes a machine-readable report. The
windowed ``HubFetch.exe`` has no console streams, so every diagnostic is
guarded against a ``None`` ``sys.stderr``.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Final

import PySide6
from PySide6.QtWidgets import QApplication

import hubfetch
from hubfetch.application.bootstrap import SystemClock, bootstrap_runtime
from hubfetch.application.runtime_contracts import RuntimeShutdownStartedError
from hubfetch.config.bootstrap import (
    ConfigurationError,
    SettingsValidationError,
    bootstrap_configuration,
)
from hubfetch.config.paths import HUBFETCH_APP_DATA_ROOT_ENV
from hubfetch.config.settings import Settings
from hubfetch.persistence.connection import ConnectionOpenError, open_connection
from hubfetch.persistence.migrations import UnsupportedSchemaVersionError, migrate
from hubfetch.persistence.settings_repository import SettingsRepository
from hubfetch.ui import focus, fonts
from hubfetch.ui import style as ui_style
from hubfetch.ui.main_window import MainWindow
from hubfetch.ui.navigation import ShellTexts

from ._askpass import run_packaged_askpass
from ._contract import (
    REQUIRED_PACKAGE_ENTRIES as _REQUIRED_PACKAGE_ENTRIES,
)
from ._contract import (
    AskPassContractResult,
    PackageScan,
    SmokeArgs,
    SmokeResult,
    is_amd64_pe,
    is_forbidden_package_path,
    parse_smoke_args,
    scan_tree_for_sentinel,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from hubfetch.application.runtime import Runtime
    from hubfetch.config.paths import AppPathsResult

_SHUTDOWN_WAIT_S: Final = 15.0
_QT_PLATFORM_CANDIDATES: Final = ("offscreen", "minimal", "windows")


def _import_origins() -> dict[str, str]:
    """Record where hubfetch and PySide6 were imported from in this process."""
    return {
        "hubfetch": hubfetch.__file__ or "",
        "PySide6": PySide6.__file__ or "",
    }


def _select_qt_platform() -> str:
    """Choose an available Qt platform plugin, offscreen when possible."""
    frozen_base = getattr(sys, "_MEIPASS", None)
    if isinstance(frozen_base, str):
        plugin_dir = Path(frozen_base) / "PySide6" / "plugins" / "platforms"
        if plugin_dir.is_dir():
            available = {path.stem for path in plugin_dir.glob("*.dll")}
            for candidate in _QT_PLATFORM_CANDIDATES:
                if candidate in available:
                    return candidate
    return "offscreen"


def _scan_package() -> PackageScan:
    """Scan the packaged tree for required inventory, bans, and sentinels."""
    root = Path(sys.executable).parent
    relative = tuple(
        path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()
    )
    missing = tuple(
        entry
        for entry in _REQUIRED_PACKAGE_ENTRIES
        if not any(path.endswith(entry) for path in relative)
    )
    forbidden = tuple(path for path in relative if is_forbidden_package_path(path))
    sentinel_files = tuple(str(path) for path in scan_tree_for_sentinel(root))
    return PackageScan(
        ok=not missing and not forbidden and not sentinel_files,
        missing=missing,
        forbidden=forbidden,
        sentinel_files=sentinel_files,
    )


def run_smoke(args: SmokeArgs) -> int:
    """Run the full headless smoke and write the machine-readable report."""
    os.environ[HUBFETCH_APP_DATA_ROOT_ENV] = str(args.app_data_root)
    errors: list[str] = []
    configuration: AppPathsResult | None = None
    try:
        configuration = bootstrap_configuration().paths
    except ConfigurationError as error:
        errors.append(f"configuration: {error}")
    database_created = False
    settings_roundtrip = False
    if configuration is not None:
        try:
            connection = open_connection(configuration.database_path)
            try:
                migrate(connection)
                database_created = configuration.database_path.is_file()
                repository = SettingsRepository(connection, clock=SystemClock())
                _ = repository.save(Settings())
                settings_roundtrip = repository.load() is not None
            finally:
                connection.close()
        except (
            ConnectionOpenError,
            UnsupportedSchemaVersionError,
            sqlite3.Error,
        ) as error:
            errors.append(f"persistence: {error}")
    fonts_registered: tuple[str, ...] = ()
    qt_platform = ""
    try:
        _ = os.environ.setdefault("QT_QPA_PLATFORM", _select_qt_platform())
        app = QApplication([])
        fonts_registered = fonts.register_bundled_fonts()
        qt_platform = app.platformName()
    except (ImportError, RuntimeError, OSError) as error:
        errors.append(f"qt: {error}")
    askpass: AskPassContractResult | None = (
        run_packaged_askpass(errors) if configuration is not None else None
    )
    scan = (
        _scan_package()
        if getattr(sys, "frozen", False)
        else PackageScan(ok=True, missing=(), forbidden=(), sentinel_files=())
    )
    pe_architecture = "unknown"
    try:
        with Path(sys.executable).open("rb") as stream:
            pe_architecture = "amd64" if is_amd64_pe(stream.read(4096)) else "unknown"
    except OSError as error:
        errors.append(f"pe header: {error}")
    result = SmokeResult(
        python_exe=str(Path(sys.executable)),
        frozen=getattr(sys, "frozen", False),
        pe_architecture=pe_architecture,
        module_origins=_import_origins(),
        sys_path=tuple(sys.path),
        qt_platform=qt_platform,
        fonts_registered=fonts_registered,
        settings_roundtrip=settings_roundtrip,
        database_created=database_created,
        package_inventory_ok=scan.ok,
        missing_package_entries=scan.missing,
        forbidden_package_entries=scan.forbidden,
        sentinel_files=scan.sentinel_files,
        askpass=askpass,
        errors=tuple(errors),
    )
    json_path = (
        args.smoke_json
        if args.smoke_json is not None
        else args.app_data_root / "smoke-result.json"
    )
    json_path.parent.mkdir(parents=True, exist_ok=True)
    _ = json_path.write_text(f"{result.to_json()}\n", encoding="utf-8")
    return 0 if result.passed else 1


def _load_default_settings(paths: AppPathsResult) -> Settings:
    """Return persisted settings or the locked defaults when unavailable."""
    try:
        connection = open_connection(paths.database_path)
    except ConnectionOpenError:
        return Settings()
    try:
        loaded = SettingsRepository(connection, clock=SystemClock()).load()
        return loaded if loaded is not None else Settings()
    except (sqlite3.Error, SettingsValidationError):
        return Settings()
    finally:
        connection.close()


def _shutdown_runtime(app: QApplication, runtime: Runtime) -> None:
    """Drive the bounded orderly shutdown once the capture is complete."""
    try:
        shutdown = runtime.shutdown()
    except (RuntimeShutdownStartedError, sqlite3.Error):
        runtime.close()
        return
    deadline = time.monotonic() + _SHUTDOWN_WAIT_S
    while not shutdown.finished_cleanly and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.01)
    runtime.close()


def run_capture(args: SmokeArgs) -> int:
    """Launch the real Tasks shell offscreen and capture the empty shell PNG."""
    if args.capture_path is None:
        return 2
    os.environ[HUBFETCH_APP_DATA_ROOT_ENV] = str(args.app_data_root)
    _ = os.environ.setdefault("QT_QPA_PLATFORM", _select_qt_platform())
    app = QApplication([])
    _ = fonts.register_bundled_fonts()
    _ = app.setStyle(ui_style.SHOWCASE_STYLE)
    _ = focus.install_focus_ring(app.style())
    outcome = bootstrap_runtime()
    if outcome.fatal is not None or outcome.runtime is None or outcome.paths is None:
        return 1
    settings = _load_default_settings(outcome.paths)
    texts = ShellTexts.for_locale(settings.locale)
    window = MainWindow(
        runtime=outcome.runtime,
        settings=settings,
        texts=texts,
        save_settings=_discard_settings,
        degraded=outcome.degraded,
    )
    window.show()
    app.processEvents()
    app.processEvents()
    saved = window.grab().save(str(args.capture_path))
    _shutdown_runtime(app, outcome.runtime)
    return 0 if saved else 1


def _discard_settings(settings: Settings) -> None:
    """Drop capture-mode settings edits; the capture never changes the shell."""
    _ = settings


def _write_diagnostic(message: str) -> None:
    """Write one diagnostic; the windowed exe has no console streams."""
    stream = sys.stderr
    if stream is not None:
        _ = stream.write(message)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the requested smoke mode and return the process exit code."""
    raw = tuple(sys.argv[1:] if argv is None else argv)
    try:
        args = parse_smoke_args(raw)
    except ValueError as error:
        _write_diagnostic(f"smoke: {error}\n")
        return 2
    if args.mode == "capture":
        return run_capture(args)
    return run_smoke(args)
