"""HubFetch Windows one-folder package policy (Todo 29).

Two executables share one COLLECT tree under dist/HubFetch/: the GUI
``HubFetch.exe`` (windowed) and the console ``HubFetchAskPass.exe``. Qt and
PySide6 DLLs and plugins are copied as loose, dynamically replaceable files.
UPX, one-file mode, static Qt, bundled Git/Git-Xet/hf CLIs, and GPL-only Qt
modules are prohibited; scripts/check_package_policy.py enforces this policy
declaratively and against the built artifact without executing the spec. The stock
PySide6 hooks and runtime hook remain active; the GUI TOC is trimmed only after
Analysis has collected those runtime dependencies.
"""

import sys
import sysconfig
from pathlib import Path

SPEC_DIR = Path(SPECPATH)
REPO_ROOT = SPEC_DIR.parent
sys.path[:] = [
    entry
    for entry in sys.path
    if entry and Path(entry).resolve() != REPO_ROOT.resolve()
]
SITE_PACKAGES = Path(sysconfig.get_paths()["purelib"])
PYSIDE6 = SITE_PACKAGES / "PySide6"
SHIBOKEN = SITE_PACKAGES / "shiboken6"

# ---------------------------------------------------------------------------
# Declarative policy constants — validated by scripts/check_package_policy.py.
# ---------------------------------------------------------------------------

# (destination_relative_to__internal, source_file_basename). Sources are
# resolved by _resolve_resource() against the appropriate base directory.
# Runtime resources (fonts, icons, migration SQL) land under resources/ and
# hubfetch/ so the frozen-aware resource roots in hubfetch/ui/fonts.py and
# hubfetch/ui/icons.py (sys._MEIPASS) resolve them.
RESOURCE_PLAN = (
    # Qt platform plugins (replaceable loose DLLs under PySide6/plugins/).
    ("PySide6/plugins/platforms", "qwindows.dll"),
    ("PySide6/plugins/platforms", "qminimal.dll"),
    ("PySide6/plugins/platforms", "qoffscreen.dll"),
    ("PySide6/plugins/imageformats", "qgif.dll"),
    ("PySide6/plugins/imageformats", "qico.dll"),
    ("PySide6/plugins/imageformats", "qjpeg.dll"),
    ("PySide6/plugins/imageformats", "qsvg.dll"),
    ("PySide6/plugins/tls", "qschannelbackend.dll"),
    ("PySide6/plugins/iconengines", "qsvgicon.dll"),
    ("PySide6/plugins/styles", "qmodernwindowsstyle.dll"),
    # Qt translations (Simplified Chinese is the default locale).
    ("PySide6/translations", "qtbase_zh_CN.qm"),
    # Application i18n catalogs (kept for license/compliance evidence).
    ("hubfetch/i18n", "hubfetch_zh_CN.qm"),
    ("hubfetch/i18n", "hubfetch_en_US.qm"),
    # Runtime resources under resources/: Cascadia Mono + OFL, Lucide icons.
    ("resources/fonts", "CascadiaMono.ttf"),
    ("resources/fonts", "OFL.txt"),
    ("resources/icons", "LICENSE.md"),
    ("resources/icons", "activity.svg"),
    ("resources/icons", "arrow-left.svg"),
    ("resources/icons", "check.svg"),
    ("resources/icons", "chevron-down.svg"),
    ("resources/icons", "circle-alert.svg"),
    ("resources/icons", "circle-check.svg"),
    ("resources/icons", "circle-pause.svg"),
    ("resources/icons", "circle-x.svg"),
    ("resources/icons", "clock.svg"),
    ("resources/icons", "database.svg"),
    ("resources/icons", "download.svg"),
    ("resources/icons", "file.svg"),
    ("resources/icons", "folder.svg"),
    ("resources/icons", "git-branch.svg"),
    ("resources/icons", "globe.svg"),
    ("resources/icons", "inbox.svg"),
    ("resources/icons", "info.svg"),
    ("resources/icons", "list-todo.svg"),
    ("resources/icons", "loader-circle.svg"),
    ("resources/icons", "lock.svg"),
    ("resources/icons", "play.svg"),
    ("resources/icons", "plus.svg"),
    ("resources/icons", "rotate-cw.svg"),
    ("resources/icons", "settings.svg"),
    ("resources/icons", "shield.svg"),
    ("resources/icons", "square-terminal.svg"),
    ("resources/icons", "triangle-alert.svg"),
    ("resources/icons", "x.svg"),
    # SQL migrations loaded relative to hubfetch/persistence/migrations.py.
    ("hubfetch/persistence/sql", "001_initial.sql"),
    # Licenses: project MIT, notices, Qt LGPL/GPL texts, and compliance doc.
    ("licenses", "LICENSE"),
    ("licenses", "THIRD_PARTY_NOTICES.md"),
    ("licenses/qt", "LGPL-3.0.txt"),
    ("licenses/qt", "GPL-3.0.txt"),
    ("docs", "qt-lgpl-compliance.md"),
    ("docs", "help_url_template.conf"),
)

# Qt/PySide6 DLLs shipped as loose, replaceable files. This is the required
# link-time closure of the imported PySide6 extension modules plus the Qt
# Network library carried by the release policy. The stock PySide6 hooks add
# runtime support files, and _trim_gui_qt_toc removes unrelated Qt modules only
# after those hooks have run. The built dist/ is asserted by
# scripts/check_package_policy.py --dist.

EXPECTED_QT_DLLS = (
    "Qt6Core.dll",
    "Qt6Gui.dll",
    "Qt6Widgets.dll",
    "Qt6OpenGL.dll",
    "Qt6Xml.dll",
    "Qt6DBus.dll",
    "Qt6Network.dll",
    "Qt6Svg.dll",
    "pyside6.abi3.dll",
    "shiboken6.abi3.dll",
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
    "PySide6.QtWebEngineQuick",
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
    # PySide6 runtime support: shiboken6 is the binding runtime, inspect is a
    # stock-hook hiddenimport, and PySide6.support.deprecated powers the Qt
    # flag ``|``/``&`` operators (PySide6 >= 6.4).
    "shiboken6",
    "inspect",
    "PySide6.support.deprecated",
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
    if destination == "hubfetch/persistence/sql":
        return (
            str(REPO_ROOT / "src" / "hubfetch" / "persistence" / "sql" / filename),
            destination,
        )
    if destination == "resources/fonts":
        return (str(REPO_ROOT / "resources" / "fonts" / filename), destination)
    if destination == "resources/icons":
        return (str(REPO_ROOT / "resources" / "icons" / filename), destination)
    if destination == "licenses":
        return (str(REPO_ROOT / filename), destination)
    if destination == "licenses/qt":
        return (str(SPEC_DIR / "license_texts" / filename), destination)
    if destination == "docs":
        return (str(REPO_ROOT / "docs" / filename), destination)
    raise ValueError(f"unmapped resource destination: {destination}")


def _collect_datas():
    return [
        _resolve_resource(destination, filename)
        for destination, filename in RESOURCE_PLAN
    ]


# (source_basename, destination_dir_under__internal). Qt6* and the pyside6
# ABI DLL live in the PySide6 package dir; shiboken6.abi3.dll lives in the
# shiboken6 package dir and must ship next to Shiboken.pyd.
_QT_BINARY_PLAN = (
    ("Qt6Core.dll", "PySide6"),
    ("Qt6Gui.dll", "PySide6"),
    ("Qt6Widgets.dll", "PySide6"),
    ("Qt6Network.dll", "PySide6"),
    ("Qt6OpenGL.dll", "PySide6"),
    ("Qt6Xml.dll", "PySide6"),
    ("Qt6DBus.dll", "PySide6"),
    ("Qt6Svg.dll", "PySide6"),
    ("pyside6.abi3.dll", "PySide6"),
    ("shiboken6.abi3.dll", "shiboken6"),
)


def _collect_qt_binaries():
    """Resolve the targeted Qt/PySide6 DLL plan into ``(source, dest)`` pairs.

    Never use ``collect_dynamic_libs("PySide6")`` here: it copies every DLL
    under the PySide6 package — including GPL-only modules (QtCharts,
    QtDataVisualization, QtVirtualKeyboard, QtNetworkAuth, QtWebEngine) and
    heavy modules HubFetch never imports (Qt3D*, QtMultimedia, QtQuick3D, the
    QML tree) — into the artifact. This allowlist ships exactly the required
    DLLs and fails the build when any of them is missing.
    """
    binaries = []
    for basename, destination in _QT_BINARY_PLAN:
        base = PYSIDE6 if destination == "PySide6" else SHIBOKEN
        source = base / basename
        if not source.is_file():
            raise FileNotFoundError(f"required Qt binary missing: {source}")
        binaries.append((str(source), destination))
    return binaries


_QT_PLUGIN_DESTINATIONS = frozenset(
    destination + chr(47) + filename
    for destination, filename in RESOURCE_PLAN
    if destination.startswith("PySide6/plugins/")
)
_QT_TRANSLATION_DESTINATIONS = frozenset(
    destination + chr(47) + filename
    for destination, filename in RESOURCE_PLAN
    if destination == "PySide6/translations"
)
_QT_RUNTIME_SUPPORT_DLLS = frozenset({"opengl32sw.dll"})


def _toc_destination(entry):
    """Return one PyInstaller TOC destination with normalized separators."""
    return str(entry[0]).replace(chr(92), chr(47))


def _keep_gui_qt_binary(entry):
    """Keep stock runtime support and the explicit Qt binary allowlist."""
    destination = _toc_destination(entry)
    if destination.startswith("PySide6/plugins/"):
        return destination in _QT_PLUGIN_DESTINATIONS
    if destination.startswith("PySide6/"):
        basename = Path(destination).name.casefold()
        required = {name.casefold() for name in EXPECTED_QT_DLLS}
        support = {name.casefold() for name in _QT_RUNTIME_SUPPORT_DLLS}
        if basename in required or basename in support:
            return True
        return not basename.startswith("qt6")
    if destination.startswith("shiboken6/"):
        basename = Path(destination).name.casefold()
        return not basename.endswith(".dll") or basename == "shiboken6.abi3.dll"
    return True


def _keep_gui_qt_data(entry):
    """Keep only the replaceable plugin and locale resources from stock hooks."""
    destination = _toc_destination(entry)
    if destination.startswith("PySide6/plugins/"):
        return destination in _QT_PLUGIN_DESTINATIONS
    if destination.startswith("PySide6/translations/"):
        return destination in _QT_TRANSLATION_DESTINATIONS
    return not destination.startswith("PySide6/qml/")


def _trim_gui_qt_toc(analysis):
    """Trim stock Qt collection without touching its runtime hooks."""
    analysis.binaries = [
        entry for entry in analysis.binaries if _keep_gui_qt_binary(entry)
    ]
    analysis.datas = [entry for entry in analysis.datas if _keep_gui_qt_data(entry)]


# PySide6 DLLs as loose binaries inside _internal/PySide6 (replaceable).
qt_binaries = _collect_qt_binaries()

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

_trim_gui_qt_toc(a_gui)

a_ask = Analysis(
    [str(SPEC_DIR / "askpass_entry.py")],
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
