"""Declarative policy expectations shared by the package-policy rules.

These constants encode the Must-have / Must-NOT-have contract of the portable
package: the required replaceable-Qt resources, the GPL-only Qt module
blocklist, the required loose Qt DLLs, the forbidden bundled binaries and
paths, and the exact entry-point/COLLECT layout. scripts/check_package_policy.py
asserts the shipped spec against them.
"""

from __future__ import annotations

import re
from typing import Final

GPL_ONLY_QT_MODULES: Final = frozenset(
    {
        "PySide6.QtCharts",
        "PySide6.QtDataVisualization",
        "PySide6.QtVirtualKeyboard",
        "PySide6.QtNetworkAuth",
        "PySide6.QtPdf",
        "PySide6.QtPdfWidgets",
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",
        "PySide6.QtWebEngine",
        "PySide6.QtWebView",
        "PySide6.QtQuick3D",
        "PySide6.QtSensors",
        "PySide6.QtSensorsQuick",
        "PySide6.QtSerialBus",
        "PySide6.QtSerialPort",
        "PySide6.QtGraphs",
        "PySide6.QtGraphsWidgets",
    }
)

REQUIRED_RESOURCES: Final = frozenset(
    {
        ("PySide6/plugins/platforms", "qwindows.dll"),
        ("PySide6/plugins/tls", "qschannelbackend.dll"),
        ("PySide6/plugins/imageformats", "qico.dll"),
        ("PySide6/translations", "qtbase_zh_CN.qm"),
        ("licenses", "THIRD_PARTY_NOTICES.md"),
        ("licenses", "LICENSE"),
        ("licenses/qt", "LGPL-3.0.txt"),
        ("licenses/qt", "GPL-3.0.txt"),
        ("fonts", "CascadiaMono.ttf"),
        ("fonts", "OFL.txt"),
        ("hubfetch/i18n", "hubfetch_zh_CN.qm"),
        ("docs", "qt-lgpl-compliance.md"),
        ("docs", "help_url_template.conf"),
    }
)

REQUIRED_QT_DLLS: Final = frozenset(
    {"Qt6Core.dll", "Qt6Gui.dll", "Qt6Widgets.dll", "shiboken6.abi3.dll"}
)

BANNED_BINARY: Final = re.compile(
    r"(?:^|[-_.])(?:git|xet|hf)(?:-credential)?(?:-[a-z0-9]+)?\.exe$|^xet(?:\.exe)?$",
    re.IGNORECASE,
)
DATABASE_PATH: Final = re.compile(
    r"\.(?:db|sqlite|sqlite3|db-wal|db-shm)(?:[\\/]|$)", re.IGNORECASE
)
FORBIDDEN_SEGMENT: Final = frozenset(
    {"research", "evidence", "cache", "logs", "log", ".pytest_cache", ".ruff_cache"}
)

EXPECTED_ENTRYPOINTS: Final = frozenset(
    {("HubFetch", False), ("HubFetchAskPass", True)}
)
EXPECTED_COLLECT: Final = "HubFetch"
