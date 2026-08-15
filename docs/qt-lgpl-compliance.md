# LGPL Compliance for the HubFetch Windows Package

This document explains how the HubFetch portable Windows package complies with
the GNU Lesser General Public License, version 3 (LGPL-3.0) for its Qt
components, and how an end user can exercise the rights that license grants.

## Component licensing

| Component | Version | License | How used |
|---|---|---|---|
| Qt (via PySide6) | 6.11.1 | LGPL-3.0-only | Dynamically linked runtime libraries (`Qt6Core.dll`, `Qt6Gui.dll`, `Qt6Widgets.dll`, `Qt6Svg.dll`, `Qt6Network.dll`, ...) |
| PySide6 / PySide6-Essentials / PySide6-Addons | 6.11.1 | LGPL-3.0-only | Python bindings for the Qt libraries |
| shiboken6 | 6.11.1 | LGPL-3.0-only | CPython binding runtime shared library (`shiboken6.abi3.dll`) |
| HubFetch application | 0.1.0 | MIT | Application code and resources |

HubFetch selects the **LGPL-3.0** option for Qt/PySide6. GPL-only Qt modules
(QtCharts, QtWebEngine, QtWebView, QtVirtualKeyboard, QtPdf, QtQuick,
QtQml, ...) are excluded from the import graph at packaging time by
`packaging/hubfetch.spec` (the `EXCLUDES` tuple), the PyInstaller hook
`packaging/hooks/hook-hubfetch.app.py`, and are rejected by
`scripts/check_package_policy.py` if they ever reappear.

## Why dynamic linking

All Qt and shiboken binaries are shipped as **loose, dynamically linked DLLs**
inside the one-folder `dist/HubFetch/` tree under `_internal/PySide6/`. They
are collected with `collect_dynamic_libs("PySide6")` at build time and are not
statically linked into `HubFetch.exe` or `HubFetchAskPass.exe`. Because the
user can replace the DLLs and Qt plugins directly in the installed tree, the
work must be relinkable against the Qt library sources, which is exactly what
LGPL-3.0 section 4 requires for an "application" that uses the library.

There is no one-file mode, no UPX compression, and no static Qt: every shipped
Qt binary stays a separate, replaceable file.

## Rights this package preserves

- **Use for any purpose** — no license fee, no technical restriction on how
  the application is used.
- **Replacement of the Qt libraries** — replace any DLL or plugin under
  `_internal/PySide6/` with a version you built yourself; the application
  loads the replacement at startup. This includes platform plugins
  (`qwindows.dll`), TLS backends (`qschannelbackend.dll`), image formats,
  icon engines, and translations.
- **Reverse engineering for debugging** — LGPL-3.0 section 6 permits
  reverse engineering to debug modifications to the library.
- **Corresponding Source** — the source code of the Qt libraries used to
  build the shipped binaries is available from the Qt Company and the KDE
  project at the URLs below, with the exact build configuration recorded in
  `THIRD_PARTY_NOTICES.md` and the version metadata in
  `packaging/version_info.txt`.

## Corresponding source and relinking

To relink HubFetch against your own Qt build:

1. Download the Qt 6.11.1 source release from
   <https://download.qt.io/official_releases/qt/6.11/6.11.1/single/>
   (or your distro's Qt 6.11.1 package).
2. Build Qt with the modules listed in `THIRD_PARTY_NOTICES.md`
   (`Core`, `Gui`, `Widgets`, `Svg`, `Network`, `Xml`, `OpenGL`, `DBus`).
3. Replace the matching DLLs under `_internal/PySide6/` in the unpacked
   package with your build outputs, keeping the same file names.
4. Rebuild the Python bindings from the PySide6 6.11.1 source
   (<https://code.qt.io/cgit/pyside/pyside-setup.git>) against your Qt build,
   or replace only the Qt DLLs if you keep the stock bindings.
5. Start `HubFetch.exe`; the application loads your libraries.

## Text of the licenses

The full text of both licenses ships inside the package:

- `licenses/qt/LGPL-3.0.txt` — GNU Lesser General Public License v3
- `licenses/qt/GPL-3.0.txt` — GNU General Public License v3 (also shipped
  because it is referenced by the LGPL for the option to relicense under GPL)

A copy of the GNU GPL v3 is additionally required by LGPL-3.0 section 4 to be
provided alongside the library.

## Prominent notice

The `licenses/THIRD_PARTY_NOTICES.md` file inside the package lists every
third-party component, its version, its license, and its homepage, and is
generated deterministically from the frozen `uv.lock`. The project's own MIT
license ships as `licenses/LICENSE`.

## Fonts

The bundled Cascadia Mono font (`fonts/CascadiaMono.ttf`) is licensed under
the SIL Open Font License 1.1; its text ships as `fonts/OFL.txt`. The font is
not modified.

## What is NOT bundled

HubFetch does not bundle Git, Git-Xet, the Hugging Face CLI, any database,
cache, log, research, or evidence files, nor any installer or updater. The
package performs no update check and makes no network call at startup.

## How to verify

Run the packaging gates from the repository root:

```powershell
uv run pytest -q tests/packaging/test_manifest.py tests/packaging/test_license_policy.py
uv run python scripts/generate_notices.py --check
uv run python scripts/check_package_policy.py packaging/hubfetch.spec --json .omo/evidence/task-29-windows-huggingface-manager/package-policy.json
```

`check_package_policy.py` exits non-zero if any GPL-only Qt module is present,
if a required replaceable Qt resource is missing, or if the license mapping is
incomplete.
