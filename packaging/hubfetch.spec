# -*- mode: python ; coding: utf-8 -*-
"""HubFetch Windows one-folder package policy (Todo 29).

Two executables share one COLLECT tree under dist/HubFetch/: the GUI
``HubFetch.exe`` (windowed) and the console ``HubFetchAskPass.exe``. Qt and
PySide6 DLLs and plugins are copied as loose, dynamically replaceable files.
UPX, one-file mode, static Qt, bundled Git/Git-Xet/hf CLIs, and GPL-only Qt
modules are prohibited; scripts/check_package_policy.py enforces this policy
declaratively without executing the spec.
"""

import sysconfig
from pathlib import Path

from PyInstaller.utils.hooks import collect_dynamic_libs

SPEC_DIR = Path(SPECPATH)
REPO_ROOT = SPEC_DIR.parent
SITE_PACKAGES = Path(sysconfig.get_paths()["purelib"])
PYSIDE6 = SITE_PACKAGES / "PySide6"

# ---------------------------------------------------------------------------
# Declarative policy constants — validated by scripts/check_package_policy.py.
# ---------------------------------------------------------------------------

# (destination_relative_to__internal, source_file_basename). Sources are
# resolved by _resolve_resource() against the appropriate base directory.
RESOURCE_PLAN = (
    # Qt platform plugins (replaceable loose DLLs under PySide6/plugins/).
    ("PySide6/plugins/platforms", "qwindows.dll"),
    ("PySide6/plugins/imageformats", "qgif.dll"),
    ("PySide6/plugins/imageformats", "qico.dll"),
    ("PySide6/plugins/imageformats", "qjpeg.dll"),
    ("PySide6/plugins/imageformats", "qsvg.dll"),
    ("PySide6/plugins/tls", "qschannelbackend.dll"),
    ("PySide6/plugins/iconengines", "qsvgicon.dll"),
    ("PySide6/plugins/styles", "qwindowsvistastyle.dll"),
    # Qt translations (Simplified Chinese is the default locale).
    ("PySide6/translations", "qtbase_zh_CN.qm"),
    # Application resources: i18n catalogs, Cascadia Mono + OFL, icon.
    ("hubfetch/i18n", "hubfetch_zh_CN.qm"),
    ("hubfetch/i18n", "hubfetch_en_US.qm"),
    ("fonts", "CascadiaMono.ttf"),
    ("fonts", "OFL.txt"),
    ("icons", "hubfetch.ico"),
    # Licenses: project MIT, notices, Qt LGPL/GPL texts, and compliance doc.
    ("licenses", "LICENSE"),
    ("licenses", "THIRD_PARTY_NOTICES.md"),
    ("licenses/qt", "LGPL-3.0.txt"),
    ("licenses/qt", "GPL-3.0.txt"),
    ("docs", "qt-lgpl-compliance.md"),
    ("docs", "help_url_template.conf"),
)

# Qt/PySide6 DLLs shipped as loose, replaceable files (collected dynamically;
# this inventory is asserted by the policy checker).
EXPECTED_QT_DLLS = (
    "Qt6Core.dll",
    "Qt6Gui.dll",
    "Qt6Widgets.dll",
    "Qt6Svg.dll",
    "Qt6Network.dll",
    "Qt6OpenGL.dll",
    "Qt6Xml.dll",
    "Qt6DBus.dll",
    "shiboken6.abi3.dll",
    "PySide6.abi3.dll",
)

# GPL-only Qt modules must never enter the MIT/LGPL build, plus heavy modules
# HubFetch never imports (only QtCore/QtGui/QtWidgets/QtSvg/QtNetwork are used).
EXCLUDES = (
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
    "PySide6.QtQuick",
    "PySide6.QtQml",
    "PySide6.QtQuickControls2",
    "PySide6.QtWaylandClient",
    "PySide6.QtWaylandCompositor",
    "PySide6.QtMultimedia",
    "PySide6.QtMultimediaWidgets",
    "PySide6.Qt3DCore",
    "PySide6.Qt3DRender",
    "PySide6.QtBluetooth",
    "PySide6.QtNfc",
    "PySide6.QtPositioning",
    "PySide6.QtLocation",
    "PySide6.QtWebSockets",
    "PySide6.QtWebChannel",
    "PySide6.QtRemoteObjects",
    "PySide6.QtScxml",
    "PySide6.QtTextToSpeech",
    "PySide6.QtDesigner",
    "PySide6.QtHelp",
    "PySide6.QtTest",
    "PySide6.QtConcurrent",
    "PySide6.QtStateMachine",
    "PySide6.QtOpenGLWidgets",
)

HIDDEN_IMPORTS = (
    "hubfetch.app",
    "hubfetch.askpass.main",
    "hubfetch.ui.showcase",
)

# ---------------------------------------------------------------------------
# Resource resolution — keeps every shipped file explicit and replaceable.
# ---------------------------------------------------------------------------


def _resolve_resource(destination, filename):
    """Resolve the absolute source for one declarative resource entry."""
    if destination.startswith("PySide6/plugins/"):
        category = destination.removeprefix("PySide6/plugins/")
        return (str(PYSIDE6 / "plugins" / category / filename), destination)
    if destination == "PySide6/translations":
        return (str(PYSIDE6 / "translations" / filename), destination)
    if destination == "hubfetch/i18n":
        return (str(REPO_ROOT / "resources" / "i18n" / filename), destination)
    if destination == "fonts":
        return (str(REPO_ROOT / "resources" / "fonts" / filename), destination)
    if destination == "icons":
        return (str(SPEC_DIR / "resources" / filename), destination)
    if destination == "licenses":
        return (str(REPO_ROOT / filename), destination)
    if destination == "licenses/qt":
        return (str(SPEC_DIR / "license_texts" / filename), destination)
    if destination == "docs":
        return (str(REPO_ROOT / "docs" / filename), destination)
    raise ValueError(f"unmapped resource destination: {destination}")


def _collect_datas():
    return [_resolve_resource(destination, filename) for destination, filename in RESOURCE_PLAN]


# PySide6 DLLs as loose binaries inside _internal/PySide6 (replaceable).
qt_binaries = collect_dynamic_libs("PySide6")

a_gui = Analysis(
    [str(REPO_ROOT / "src" / "hubfetch" / "app.py")],
    pathex=[str(REPO_ROOT / "src")],
    binaries=qt_binaries,
    datas=_collect_datas(),
    hiddenimports=list(HIDDEN_IMPORTS),
    excludes=list(EXCLUDES),
    hookspath=[str(SPEC_DIR / "hooks")],
    noarchive=False,
)

a_ask = Analysis(
    [str(REPO_ROOT / "src" / "hubfetch" / "askpass" / "main.py")],
    pathex=[str(REPO_ROOT / "src")],
    binaries=[],
    datas=[],
    hiddenimports=[],
    excludes=[*EXCLUDES, "PySide6", "shiboken6"],
    hookspath=[str(SPEC_DIR / "hooks")],
    noarchive=False,
)

pyz_gui = PYZ(a_gui.pure)
pyz_ask = PYZ(a_ask.pure)

exe_gui = EXE(
    pyz_gui,
    a_gui.scripts,
    name="HubFetch",
    console=False,
    upx=False,
    icon=[str(SPEC_DIR / "resources" / "hubfetch.ico")],
    version=str(SPEC_DIR / "version_info.txt"),
)

exe_ask = EXE(
    pyz_ask,
    a_ask.scripts,
    name="HubFetchAskPass",
    console=True,
    upx=False,
    version=str(SPEC_DIR / "version_info.txt"),
)

coll = COLLECT(
    exe_gui,
    a_gui.binaries,
    a_gui.datas,
    exe_ask,
    a_ask.binaries,
    a_ask.datas,
    name="HubFetch",
)
