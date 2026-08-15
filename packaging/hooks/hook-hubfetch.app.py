# noqa: N999 — PyInstaller hook files are named ``hook-<module>.py`` and are
# never imported, so the invalid import name is intentional.
"""PyInstaller hook for the HubFetch GUI entry point (Todo 29 policy).

This hook supplements the Analysis-level ``EXCLUDES`` in packaging/hubfetch.spec:
GPL-only Qt modules (QtCharts, QtWebEngine, ...) and heavy modules HubFetch
never imports are excluded from the import graph regardless of which hook
chain collected them. scripts/check_package_policy.py asserts both this hook
and the spec agree with the GPL-only module blocklist.
"""

excludedimports = [
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
]
