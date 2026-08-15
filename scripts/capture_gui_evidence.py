"""Capture GUI evidence PNGs for the four destinations and both create dialogs.

Drives the real composed shell offscreen in the light theme at 1280 px and
grabs one PNG per surface: Tasks, Cache, Diagnostics, Settings, the File menu,
and the Download/Clone dialogs. It navigates only through the public
``NavigationModel.set_destination`` routing, so it also renders faithfully
against the pre-fix shell (which shows the pending placeholder) for before/after
evidence. Run from the repo root with ``uv run --frozen --offline python
scripts/capture_gui_evidence.py <outdir>``.
"""

from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

from PySide6.QtCore import QPoint
from PySide6.QtWidgets import QApplication, QDialog, QMenu

from hubfetch.application.bootstrap import bootstrap_runtime
from hubfetch.application.runtime_contracts import RuntimeShutdownStartedError
from hubfetch.config.settings import Locale, Settings, Theme
from hubfetch.ui import focus, fonts
from hubfetch.ui import style as ui_style
from hubfetch.ui.create import CloneDialog, DownloadDialog
from hubfetch.ui.main_window import MainWindow
from hubfetch.ui.navigation import Destination, ShellTexts

if TYPE_CHECKING:
    from collections.abc import Sequence

    from hubfetch.application.runtime import Runtime

_WIDTH: int = 1280
_HEIGHT: int = 768
_SHUTDOWN_WAIT_S: float = 15.0


def _select_qt_platform() -> str:
    """Choose an available Qt platform plugin, offscreen when possible."""
    frozen_base = getattr(sys, "_MEIPASS", None)
    if isinstance(frozen_base, str):
        plugin_dir = Path(frozen_base) / "PySide6" / "plugins" / "platforms"
        if plugin_dir.is_dir():
            available = {path.stem for path in plugin_dir.glob("*.dll")}
            for candidate in ("offscreen", "minimal", "windows"):
                if candidate in available:
                    return candidate
    return "offscreen"


def _shutdown_runtime(app: QApplication, runtime: Runtime) -> None:
    """Drive the bounded orderly shutdown once the captures are complete."""
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


def _flush(app: QApplication) -> None:
    """Flush posted events so the shell settles before one grab."""
    app.processEvents()
    app.processEvents()


def _capture_dialog(app: QApplication, dialog: QDialog | None, path: Path) -> None:
    """Grab one create dialog after its layout has settled."""
    _flush(app)
    if dialog is not None:
        _ = dialog.grab().save(str(path))


def _capture_destination(
    app: QApplication, window: MainWindow, destination: Destination, path: Path
) -> None:
    """Route to one destination through the public model and grab the shell."""
    window.navigation_model().set_destination(destination)
    _flush(app)
    _ = window.grab().save(str(path))


def main(argv: Sequence[str] | None = None) -> int:
    """Run the capture and return the process exit code."""
    raw = tuple(sys.argv[1:] if argv is None else argv)
    if not raw:
        return 2
    out = Path(raw[0])
    out.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("QT_QPA_PLATFORM", _select_qt_platform())
    app = QApplication([])
    _ = fonts.register_bundled_fonts()
    app.setStyle(ui_style.SHOWCASE_STYLE)
    _ = focus.install_focus_ring(app.style())
    app.setPalette(ui_style.build_light_palette())
    outcome = bootstrap_runtime()
    if outcome.fatal is not None or outcome.runtime is None or outcome.paths is None:
        return 1
    runtime = outcome.runtime
    window = MainWindow(
        runtime=runtime,
        settings=Settings(theme=Theme.LIGHT, locale=Locale.ZH_CN),
        texts=ShellTexts.for_locale(Locale.ZH_CN),
        save_settings=lambda _settings: None,
        degraded=outcome.degraded,
    )
    window.resize(_WIDTH, _HEIGHT)
    window.show()
    _flush(app)

    _capture_destination(app, window, Destination.TASKS, out / "tasks.png")
    _capture_destination(app, window, Destination.CACHE, out / "cache.png")
    _capture_destination(app, window, Destination.DIAGNOSTICS, out / "diagnostics.png")
    _capture_destination(app, window, Destination.SETTINGS, out / "settings.png")

    menu = window.findChild(QMenu)
    if menu is not None:
        window.menuBar().setActiveAction(window.menuBar().actions()[0])
        menu.popup(window.mapToGlobal(QPoint(16, 16)))
        _flush(app)
        _ = menu.grab().save(str(out / "file-menu.png"))
        menu.close()

    window.navigation_model().set_destination(Destination.TASKS)
    _flush(app)
    window.new_download_action().trigger()
    _flush(app)
    download = window.findChild(DownloadDialog)
    _capture_dialog(app, download, out / "download-dialog.png")
    if download is not None:
        download.close()
    window.new_clone_action().trigger()
    _flush(app)
    clone = window.findChild(CloneDialog)
    _capture_dialog(app, clone, out / "clone-dialog.png")
    if clone is not None:
        clone.close()

    _shutdown_runtime(app, runtime)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
