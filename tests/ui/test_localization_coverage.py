# noqa: SIZE_OK - one module must enumerate the whole localization coverage
# contract: catalog completeness, per-locale independence, the bilingual auth
# vocabulary, the AST extraction check for untranslated UI literals, and the
# lrelease compile proof.

"""Given/When/Then coverage contracts for the bilingual UI catalogs.

Todo 28 completes every Simplified Chinese and English catalog entry and proves
zero missing IDs and zero untranslated UI literals in the auth surface: both
catalogs cover the full required message set independently, the bilingual auth
vocabulary is complete in both locales (no sentinel, no empty, genuinely
translated), no prose literal bypasses the vocabulary in the auth sources, and
both catalogs compile through ``pyside6-lrelease``.
"""

from __future__ import annotations

import ast
import shutil
import subprocess
import sys
from contextlib import suppress
from dataclasses import asdict
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
from hubfetch.i18n.formatting import MissingParameterError
from hubfetch.ui.auth.texts import AuthTexts

SENTINEL: Final = "hf_test_secret_123"

TECHNICAL_PREFIXES: Final[tuple[str, ...]] = (
    "Alt+",
    "Ctrl+",
    "hfc-",
    "oauth-",
    "task-",
    "attempt-",
    "http://",
    "https://",
    "%",
    "{",
    "zh_CN",
    "en_US",
)
"""Literal prefixes that are machine keys, shortcuts, or format templates."""

TECHNICAL_WORDS: Final[frozenset[str]] = frozenset(
    {
        "HubFetch",
        "Windows",
        "huggingface_hub browser OAuth adapter",
        "w",
        "h",
        "s",
        "m",
        "d",
        "x",
        "c",
        "f",
        "e",
        "B",
        "KB",
        "MB",
        "GB",
        "TB",
        "light",
        "dark",
        "system",
        "anonymous",
        "shared",
        "manual",
        "full",
        "reduced",
        "pending",
        "expired",
        "denied",
        "cancelled",
        "failed",
        "authorized",
        "started",
        "narrow",
        "medium",
        "wide",
    }
)
"""Single technical tokens allowed inside auth source literals."""


def _auth_sources() -> tuple[Path, ...]:
    """Return every UI source file under the auth package.

    The CLI capture harness (``capture.py``, ``__main__.py``) writes console
    status lines and is not a UI surface, so it is excluded from the
    untranslated-literal scan.
    """
    root = Path(__file__).resolve().parents[2] / "src" / "hubfetch" / "ui" / "auth"
    return tuple(
        path
        for path in sorted(root.rglob("*.py"))
        if path.name not in ("capture.py", "__main__.py")
    )


def _prose_like(literal: str) -> bool:
    """Return whether a literal looks like user-facing prose.

    A literal is prose when it contains a space plus an ASCII letter, or any
    CJK character, and is not a technical key/shortcut/format/token.
    """
    has_cjk = any("\u4e00" <= char <= "\u9fff" for char in literal)
    has_english_prose = " " in literal and any(
        char.isascii() and char.isalpha() for char in literal
    )
    if not (has_cjk or has_english_prose):
        return False
    if literal.startswith(TECHNICAL_PREFIXES):
        return False
    return literal not in TECHNICAL_WORDS


def _auth_literals() -> tuple[str, ...]:
    """Extract every string constant from the auth UI sources, skipping docs."""
    literals: set[str] = set()
    for path in _auth_sources():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if _is_docstring_position(tree, node):
                continue
            literals.add(node.value)
    return tuple(sorted(literals))


def _is_docstring_position(tree: ast.Module, node: ast.Constant) -> bool:
    """Return whether a string constant is a standalone documentation statement.

    Any bare string expression statement inside a module/class/function body is
    documentation prose, not a UI literal; attribute docstrings and trailing
    comments written as bare expressions are covered the same way.
    """
    for ancestor in ast.walk(tree):
        if not isinstance(ancestor, (ast.Module, ast.ClassDef, ast.FunctionDef)):
            continue
        for statement in ancestor.body:
            if isinstance(statement, ast.Expr) and statement.value is node:
                return True
    return False


def _catalog_values(catalog: MessageCatalog, locale: Locale) -> frozenset[str]:
    """Return every translated value the catalog renders for one locale.

    Both the raw template and a rendered-with-sample-parameter variant are
    collected so fixture literals that substitute a parameter are covered.
    """
    values: set[str] = set()
    scoped = catalog.with_locale(locale)
    sample: dict[str, str | int | float] = {
        "name": "x",
        "reason": "x",
        "repo": "x",
        "revision": "x",
        "path": "x",
    }
    for message_id in required_message_ids():
        raw = scoped.raw_message(message_id)
        values.add(raw)
        with suppress(MissingParameterError):
            values.add(scoped.format_message(message_id, sample))
    return frozenset(values)


def test_required_message_ids_covered_by_both_locales() -> None:
    """Given every required message ID, neither locale reports a missing key."""
    zh = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.ZH_CN)
    en = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.EN_US)

    missing = check_catalog_coverage(zh, en, required_message_ids())

    assert missing == ()


def test_each_locale_is_independently_complete() -> None:
    """Given both catalogs, every ID exists in its own locale's table (no
    accidental dependence on the fallback catalog)."""
    zh = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.ZH_CN)
    en = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=Locale.EN_US)

    for message_id in required_message_ids():
        assert zh.message_present(message_id, Locale.ZH_CN), message_id
        assert en.message_present(message_id, Locale.EN_US), message_id


def test_no_catalog_entry_is_sentinel_or_its_own_id() -> None:
    """Given both locales, no translation is empty, the sentinel, or a bare ID."""
    for locale in (Locale.ZH_CN, Locale.EN_US):
        catalog = MessageCatalog(ts_dir=DEFAULT_TS_DIR, locale=locale)
        for message_id in required_message_ids():
            rendered = catalog.raw_message(message_id)
            assert rendered.strip()
            assert rendered != message_id
            assert SENTINEL not in rendered


def _auth_values(texts: AuthTexts) -> dict[str, str]:
    """Return every dataclass field value as a typed string mapping."""
    return asdict(texts)


def test_auth_texts_complete_in_both_locales() -> None:
    """Given the bilingual auth vocabulary, every field is present in both
    locales, non-empty, sentinel-free, and genuinely translated (zh != en)."""
    zh_values = _auth_values(AuthTexts.for_locale(Locale.ZH_CN))
    en_values = _auth_values(AuthTexts.for_locale(Locale.EN_US))

    for field, zh_value in zh_values.items():
        en_value = en_values[field]
        assert zh_value.strip(), field
        assert en_value.strip(), field
        assert SENTINEL not in zh_value, field
        assert SENTINEL not in en_value, field
        assert zh_value != en_value, f"{field} is not genuinely translated"


def test_zh_auth_texts_render_in_simplified_chinese() -> None:
    """Given the zh vocabulary, key labels are Simplified Chinese prose."""
    zh_values = _auth_values(AuthTexts.for_locale(Locale.ZH_CN))
    for field in ("ownership_shared", "ownership_hubfetch", "sign_in_browser"):
        value = zh_values[field]
        assert any("\u4e00" <= char <= "\u9fff" for char in value), field


def test_no_ui_literals_bypass_the_bilingual_vocabulary() -> None:
    """Given the auth sources, every prose-like literal is present in at least
    one locale of the bilingual vocabulary (zero untranslated UI literals)."""
    zh = AuthTexts.for_locale(Locale.ZH_CN)
    en = AuthTexts.for_locale(Locale.EN_US)
    zh_values = {getattr(zh, field) for field in zh.__dataclass_fields__}
    en_values = {getattr(en, field) for field in en.__dataclass_fields__}
    allowed = zh_values | en_values
    allowed |= _catalog_values(MessageCatalog(ts_dir=DEFAULT_TS_DIR), Locale.ZH_CN)
    allowed |= _catalog_values(MessageCatalog(ts_dir=DEFAULT_TS_DIR), Locale.EN_US)

    stray = tuple(
        literal
        for literal in _auth_literals()
        if _prose_like(literal) and literal not in allowed
    )

    assert stray == ()


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
def test_lrelease_compiles_both_catalogs(tmp_path: Path) -> None:
    """Given both catalogs, lrelease produces non-empty .qm files."""
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
