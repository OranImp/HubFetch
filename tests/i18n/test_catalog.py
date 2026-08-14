"""Tests for the bilingual Qt translation catalog and formatting contracts.

Given/When/Then: every required message ID exists in both locales; locale
fallback is deterministic (missing key -> fallback locale -> message ID);
parameters escape safely; no message is a generic-only error; and both
catalogs compile through ``pyside6-lrelease`` into a temporary directory.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path
from typing import Final

import pytest

from hubfetch.config.settings import Locale
from hubfetch.domain.errors import required_message_ids
from hubfetch.i18n.catalog import (
    DEFAULT_TS_DIR,
    MessageCatalog,
    check_catalog_coverage,
)
from hubfetch.i18n.formatting import MissingParameterError, format_plural

GENERIC_ONLY: Final[frozenset[str]] = frozenset({"发生错误", "Something went wrong"})

# zh_CN catalog deliberately missing "error.validation" to exercise fallback.
# RUF001: the fullwidth colon is written as an escape so the zh text is
# byte-identical to the catalog while the source avoids an ambiguous literal.
_MINIMAL_ZH_TS: Final = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE TS>
<TS version="2.1" language="zh_CN" sourcelanguage="en_US">
<context>
    <name>HubFetchErrors</name>
    <message>
        <source>error.network</source>
        <translation>网络请求失败\uff1a{reason}</translation>
    </message>
</context>
</TS>
"""


@pytest.fixture
def catalog() -> MessageCatalog:
    """The production catalog loaded from the committed resources directory."""
    return MessageCatalog(ts_dir=DEFAULT_TS_DIR)


def test_every_required_id_is_covered_by_both_locales() -> None:
    """Given every typed error ID, both catalogs provide a non-empty message."""
    zh = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.ZH_CN)
    en = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.EN_US)

    missing = check_catalog_coverage(zh, en, required_message_ids())

    assert missing == ()


def test_no_message_is_a_generic_only_error() -> None:
    """Given every entry in both locales, none equals a generic error phrase."""
    zh = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.ZH_CN)
    en = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.EN_US)

    for message_id in required_message_ids():
        zh_text = zh.raw_message(message_id)
        en_text = en.raw_message(message_id)
        assert zh_text.strip()
        assert en_text.strip()
        assert zh_text not in GENERIC_ONLY
        assert en_text not in GENERIC_ONLY


def test_missing_key_falls_back_to_fallback_locale(tmp_path: Path) -> None:
    """Given a zh_CN catalog missing one key, the en_US fallback is used."""
    zh_path = tmp_path / "hubfetch_zh_CN.ts"
    _ = zh_path.write_text(_MINIMAL_ZH_TS, encoding="utf-8")
    _ = shutil.copy2(
        DEFAULT_TS_DIR / "hubfetch_en_US.ts", tmp_path / "hubfetch_en_US.ts"
    )
    catalog = MessageCatalog(ts_dir=tmp_path, locale=Locale.ZH_CN)

    text = catalog.format_message("error.validation", {"reason": "empty"})

    assert text == "Invalid input: empty"


def test_missing_everywhere_returns_message_id_never_generic(tmp_path: Path) -> None:
    """Given a key absent from both locales, the message ID itself is returned."""
    catalog = MessageCatalog(ts_dir=tmp_path, locale=Locale.ZH_CN)

    text = catalog.format_message("error.validation", {"reason": "x"})

    assert text == "error.validation"
    assert text not in GENERIC_ONLY


def test_locale_switching_changes_rendered_language() -> None:
    """Given a zh_CN catalog, switching locale renders the English text."""
    zh = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.ZH_CN)

    en = zh.with_locale(Locale.EN_US)

    assert (
        zh.format_message("error.network", {"reason": "offline"})
        == "网络请求失败：offline"  # noqa: RUF001 - fullwidth colon in zh text
    )
    assert (
        en.format_message("error.network", {"reason": "offline"})
        == "Network request failed: offline"
    )


def test_parameters_escape_safely_against_format_injection() -> None:
    """Given format-string injection attempts, no parameter is interpolated."""
    catalog = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.EN_US)
    payload = "{0.__class__} %s {__class__} {{{reason}}}"

    text = catalog.format_message("error.network", {"reason": payload})

    assert "{0.__class__}" in text
    assert "{__class__}" in text
    assert "{{{reason}}}" in text
    assert "Network request failed" in text
    assert payload in text


def test_unknown_parameter_raises_typed_error() -> None:
    """Given a template requiring a missing parameter, a typed error is raised."""
    catalog = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.ZH_CN)

    with pytest.raises(MissingParameterError):
        _ = catalog.format_message("error.network", {})


def test_plural_formatting_selects_form_by_count() -> None:
    """Given a plural template, the count parameter selects the correct form."""
    assert format_plural("{count} task|{count} tasks", 1) == "1 task"
    assert format_plural("{count} task|{count} tasks", 3) == "3 tasks"


def test_required_ids_are_machine_consumed_not_translated() -> None:
    """Given every required ID, it is a stable machine key, never localized."""
    for message_id in required_message_ids():
        assert message_id.startswith(("error.", "recovery."))
        assert " " not in message_id


def _find_lrelease() -> str:
    """Return the pyside6-lrelease executable bundled with PySide6."""
    found = shutil.which("pyside6-lrelease")
    if found:
        return found
    scripts = Path(sys.executable).resolve().parent
    candidate = scripts / "pyside6-lrelease.exe"
    assert candidate.exists(), "pyside6-lrelease is not available"
    return str(candidate)


@pytest.mark.windows
def test_lrelease_compiles_both_catalogs_to_temporary_directory(tmp_path: Path) -> None:
    """Given both catalogs, lrelease compiles .qm files into a temp directory."""
    lrelease = _find_lrelease()
    for name in ("hubfetch_zh_CN", "hubfetch_en_US"):
        source = DEFAULT_TS_DIR / f"{name}.ts"
        target = tmp_path / f"{name}.qm"

        result = subprocess.run(  # noqa: S603 - fixed command list, no shell
            [lrelease, "-silent", str(source), "-qm", str(target)],
            capture_output=True,
            check=False,
            text=True,
            timeout=120,
        )

        assert result.returncode == 0, result.stderr
        assert target.exists()
        assert target.stat().st_size > 0


@pytest.mark.windows
def test_compile_translations_script_produces_qm_files(tmp_path: Path) -> None:
    """Given the compile script, both catalogs compile into the output dir."""
    script = (
        Path(__file__).resolve().parents[2] / "scripts" / "compile_translations.ps1"
    )

    powershell = shutil.which("powershell")
    assert powershell is not None, "powershell is required on Windows"

    result = subprocess.run(  # noqa: S603 - fixed command list, no shell
        [
            powershell,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-OutputDir",
            str(tmp_path),
        ],
        capture_output=True,
        check=False,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert (tmp_path / "hubfetch_zh_CN.qm").exists()
    assert (tmp_path / "hubfetch_en_US.qm").exists()
