"""Thin desktop composition root for the HubFetch shell.

Todo 24's composition root boots the runtime through :func:`bootstrap_runtime`,
applies the theme/fonts/focus ring, composes the :class:`MainWindow`, persists
window geometry through a second WAL connection to the settings table, and
drives the bounded orderly shutdown after the GUI loop exits. The GUI process
never performs transfer or network work; startup failures are either fatal
(typed :class:`FatalStartupError`, surfaced in a message box) or degraded
(non-blocking status-banner diagnostics carried into the shell).
"""

from __future__ import annotations

import sqlite3
import sys
import time
from typing import TYPE_CHECKING, Final, final

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QMessageBox

from hubfetch.application.bootstrap import (
    SystemClock,
    bootstrap_runtime,
)
from hubfetch.application.runtime_contracts import RuntimeShutdownStartedError
from hubfetch.config.bootstrap import SettingsValidationError
from hubfetch.config.settings import Settings, Theme
from hubfetch.persistence.connection import ConnectionOpenError, open_connection
from hubfetch.persistence.settings_repository import SettingsRepository
from hubfetch.ui import focus, fonts, showcase
from hubfetch.ui import style as ui_style
from hubfetch.ui.main_window import MainWindow
from hubfetch.ui.navigation import ShellTexts

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from PySide6.QtGui import QPalette

    from hubfetch.application.runtime import Runtime
    from hubfetch.config.paths import AppPathsResult

__all__ = ["main"]

_SHUTDOWN_WAIT_S: Final = 15.0
"""Upper bound on the orderly shutdown wait after the GUI loop exits."""


def _palette_for(app: QApplication, theme: Theme) -> QPalette:
    """Resolve the locked light, dark, or system-derived palette."""
    match theme:
        case Theme.LIGHT:
            return ui_style.build_light_palette()
        case Theme.DARK:
            return ui_style.build_dark_palette()
        case Theme.SYSTEM:
            if app.styleHints().colorScheme() is Qt.ColorScheme.Dark:
                return ui_style.build_dark_palette()
            return ui_style.build_light_palette()


def _load_settings(paths: AppPathsResult | None) -> Settings:
    """Return persisted settings or the locked defaults when unavailable."""
    if paths is None:
        return Settings()
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


@final
class _SettingsSaver:
    """Best-effort settings persistence through one fresh WAL connection."""

    __slots__: Final = ("_database_path",)
    _database_path: Path

    def __init__(self, database_path: Path) -> None:
        """Bind the saver to the application database path."""
        self._database_path = database_path

    def save(self, settings: Settings) -> None:
        """Persist one settings value; typed failures are silently skipped."""
        try:
            connection = open_connection(self._database_path)
        except ConnectionOpenError:
            return
        try:
            SettingsRepository(connection, clock=SystemClock()).save(settings)
        finally:
            connection.close()


def _shutdown_runtime(runtime: Runtime, app: QApplication) -> None:
    """Drive the bounded orderly shutdown once the GUI loop has exited."""
    try:
        shutdown = runtime.shutdown()
    except (RuntimeShutdownStartedError, sqlite3.Error):
        runtime.close()
        return
    deadline = time.monotonic() + _SHUTDOWN_WAIT_S
    # The emptiness poll is QTimer-driven; process events and back off briefly
    # so a full process-tree teardown never spins the CPU.
    while not shutdown.finished_cleanly and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.01)
    runtime.close()


def _show_fatal(message: str) -> None:
    """Surface a typed fatal startup failure in a native message box."""
    _ = QMessageBox.critical(None, "HubFetch", message)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the desktop application and return its process exit code."""
    args = tuple(sys.argv[1:] if argv is None else argv)
    if showcase.is_showcase_request(args):
        return showcase.run_showcase()
    app = QApplication([*args])
    fonts.register_bundled_fonts()
    app.setStyle(ui_style.SHOWCASE_STYLE)
    focus.install_focus_ring(app.style())
    outcome = bootstrap_runtime()
    if outcome.fatal is not None:
        _show_fatal(str(outcome.fatal))
        return 1
    if outcome.runtime is None or outcome.paths is None:
        return 1
    runtime = outcome.runtime
    settings = _load_settings(outcome.paths)
    app.setPalette(_palette_for(app, settings.theme))
    texts = ShellTexts.for_locale(settings.locale)
    saver = _SettingsSaver(outcome.paths.database_path)
    window = MainWindow(
        runtime=runtime,
        settings=settings,
        texts=texts,
        save_settings=saver.save,
        degraded=outcome.degraded,
    )
    window.show()
    exit_code = app.exec()
    _shutdown_runtime(runtime, app)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
