"""Entry point for the full auth-state capture matrix.

Invoked as ``python -m hubfetch.ui.auth`` by
``scripts/capture_ui_states.ps1`` (``-Mode Full``); renders the complete state
matrix offscreen and verifies every produced PNG against the manifest.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from PySide6.QtWidgets import QApplication

from hubfetch.ui import focus, fonts
from hubfetch.ui import style as ui_style

from .capture import auth_matrix, run_matrix, verify_matrix
from .manifest import ManifestName

if TYPE_CHECKING:
    from collections.abc import Sequence


def main(argv: Sequence[str] | None = None) -> int:
    """Capture the full auth-state matrix and verify the produced PNGs."""
    args = tuple(sys.argv[1:] if argv is None else argv)
    output: str | None = None
    index = 0
    while index + 1 < len(args):
        if args[index] == "--output":
            output = args[index + 1]
            index += 2
        else:
            index += 1
    if output is None:
        sys.stdout.write("usage: python -m hubfetch.ui.auth.capture --output <dir>\n")
        return 2
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication(["hubfetch-auth-capture"])
    fonts.register_bundled_fonts()
    app.setStyle(ui_style.SHOWCASE_STYLE)
    focus.install_focus_ring(app.style())
    report = run_matrix(Path(output), auth_matrix())
    sys.stdout.write(f"captured {len(report.entries)} auth states\n")
    sys.stdout.write(f"manifest: {report.manifest_path}\n")
    sys.stdout.write(f"manifest name: {ManifestName}\n")
    return verify_matrix(Path(output))


if __name__ == "__main__":
    raise SystemExit(main())
