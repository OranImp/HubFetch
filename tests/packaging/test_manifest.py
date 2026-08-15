"""Given/When/Then tests for the PyInstaller manifest policy.

The tests parse packaging/hubfetch.spec as a declarative document (without
executing it) and assert the exact entry points, the one-folder COLLECT layout,
the required replaceable-Qt resources, and the rejection of injected
disallowed constructs such as UPX, one-file mode, and bundled git.exe.
"""

from __future__ import annotations

from pathlib import Path

from scripts import check_package_policy as policy

REPO_ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = REPO_ROOT / "packaging" / "hubfetch.spec"

_BAD_SPEC_SOURCE = (
    "# -*- mode: python ; coding: utf-8 -*-\n"
    'RESOURCE_PLAN = (("bin", "git.exe"), ("data", "app.db"))\n'
    "EXCLUDES = ()\n"
    "HIDDEN_IMPORTS = ()\n"
    "EXPECTED_QT_DLLS = ()\n"
    'a = Analysis(["src/hubfetch/app.py"], '
    "datas=[], binaries=[], hiddenimports=[], excludes=[])\n"
    "pyz = PYZ(a.pure)\n"
    'exe = EXE(pyz, a.scripts, name="HubFetch", '
    "console=False, upx=True, onefile=True)\n"
    'coll = COLLECT(exe, a.binaries, a.datas, name="HubFetch")\n'
)


def test_spec_defines_exact_entry_points() -> None:
    """Given the shipped spec, When parsed, Then the GUI and AskPass entry
    points exist with the exact names and console flags inside one COLLECT.
    """
    model = policy.parse_spec(SPEC_PATH)

    entrypoints = {(entry.name, entry.console) for entry in model.entrypoints}
    assert entrypoints == {("HubFetch", False), ("HubFetchAskPass", True)}
    assert model.collect_name == "HubFetch"
    assert model.upx is False
    assert model.one_file is False


def test_spec_contains_required_resources() -> None:
    """Given the shipped spec, When the resource plan is inspected, Then every
    required plugin, license text, font, translation, notice, and compliance
    document is declared with a replaceable Qt destination.
    """
    model = policy.parse_spec(SPEC_PATH)
    plan = set(model.resource_plan)

    required = {
        ("PySide6/plugins/platforms", "qwindows.dll"),
        ("PySide6/plugins/tls", "qschannelbackend.dll"),
        ("PySide6/plugins/imageformats", "qico.dll"),
        ("PySide6/translations", "qtbase_zh_CN.qm"),
        ("licenses", "THIRD_PARTY_NOTICES.md"),
        ("licenses", "LICENSE"),
        ("licenses/qt", "LGPL-3.0.txt"),
        ("licenses/qt", "GPL-3.0.txt"),
        ("resources/fonts", "CascadiaMono.ttf"),
        ("resources/fonts", "OFL.txt"),
        ("resources/icons", "settings.svg"),
        ("hubfetch/persistence/sql", "001_initial.sql"),
        ("hubfetch/i18n", "hubfetch_zh_CN.qm"),
        ("docs", "qt-lgpl-compliance.md"),
        ("docs", "help_url_template.conf"),
    }
    assert required <= plan


def test_spec_excludes_gpl_only_qt_modules() -> None:
    """Given the shipped spec, When the excludes are inspected, Then every
    GPL-only Qt module name is excluded from the build.
    """
    model = policy.parse_spec(SPEC_PATH)
    gpl_only = policy.GPL_ONLY_QT_MODULES

    assert gpl_only <= set(model.excludes)
    assert gpl_only.isdisjoint(set(model.hidden_imports))


def test_spec_declares_replaceable_qt_dlls() -> None:
    """Given the shipped spec, When the Qt DLL inventory is inspected, Then the
    core Qt and shiboken DLLs are declared as loose, replaceable files.
    """
    model = policy.parse_spec(SPEC_PATH)

    assert {
        "Qt6Core.dll",
        "Qt6Gui.dll",
        "Qt6Widgets.dll",
        "shiboken6.abi3.dll",
    } <= set(model.expected_qt_dlls)


def test_policy_rejects_injected_disallowed_constructs(tmp_path: Path) -> None:
    """Given a temporary spec carrying UPX, one-file mode, a bundled git.exe,
    and a database path, When the policy runs, Then each construct is reported
    as a named failure.
    """
    bad_spec = tmp_path / "bad.spec"
    _ = bad_spec.write_text(_BAD_SPEC_SOURCE, encoding="utf-8")

    report = policy.run_policy(bad_spec, REPO_ROOT)

    assert report.passed is False
    rules = {failure.rule for failure in report.failures}
    assert {
        "upx-forbidden",
        "one-file-forbidden",
        "bundled-binary",
        "database-path",
    } <= rules


def test_real_spec_passes_full_policy() -> None:
    """Given the shipped spec and the frozen lock, When the complete policy
    runs, Then every rule passes and the license closure is complete.
    """
    report = policy.run_policy(SPEC_PATH, REPO_ROOT)

    assert report.passed, tuple(f"{f.rule}: {f.message}" for f in report.failures)
