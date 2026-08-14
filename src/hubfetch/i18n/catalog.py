"""Qt ``.ts`` catalog loading with deterministic locale fallback.

Catalogs are the committed Qt XML sources in ``resources/i18n``; the default
locale is Simplified Chinese and the complete English catalog is the fallback
source. Lookup order is deterministic: current locale, then the fallback
locale, then the message ID itself -- never an empty or generic string. The
UI-facing contract is ``format_message(message_id, params) -> str``; display
code requests stable IDs plus parameters and never hard-codes localized text.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Final

from hubfetch.config.settings import Locale
from hubfetch.domain.errors import MessageId, required_message_ids

from .formatting import format_plural, format_template

DEFAULT_TS_DIR: Final[Path] = Path(__file__).resolve().parents[3] / "resources" / "i18n"
"""Default directory holding the committed Qt translation catalogs."""

FALLBACK_LOCALE: Final[Locale] = Locale.EN_US
"""Locale consulted when the current locale lacks a message ID."""

_CONTEXT_NAME: Final = "HubFetchErrors"
_TS_SUFFIX: Final = ".ts"


def _load_catalog(ts_path: Path) -> dict[MessageId, str]:
    """Parse one Qt ``.ts`` file into message-ID to template mappings.

    A missing or malformed catalog resolves to an empty mapping so the caller
    degrades to the deterministic fallback chain instead of crashing; this is
    a documented load boundary and never swallows a caller bug.
    """
    try:
        tree = ET.parse(ts_path)  # noqa: S314 - trusted first-party catalogs
    except (OSError, ET.ParseError):
        return {}
    entries: dict[MessageId, str] = {}
    root = tree.getroot()
    for context in root.iter("context"):
        name = context.findtext("name")
        if name != _CONTEXT_NAME:
            continue
        for message in context.iter("message"):
            source = message.findtext("source")
            translation = message.findtext("translation")
            if source is None or translation is None:
                continue
            entries[MessageId(source)] = translation
    return entries


def _catalog_path(ts_dir: Path, locale: Locale) -> Path:
    """Return the expected ``.ts`` file path for one locale."""
    return ts_dir / f"hubfetch_{locale.value}{_TS_SUFFIX}"


class MessageCatalog:
    """Bilingual message catalog with locale switching and deterministic fallback.

    Frozen by convention: instances never mutate; ``with_locale`` returns a
    fresh catalog sharing the parsed entry tables. Message resolution follows
    the chain current locale -> fallback locale -> the message ID itself, so
    a missing key is never rendered empty or as a generic error string.
    """

    __slots__: Final = ("_en_entries", "_fallback", "_locale", "_ts_dir", "_zh_entries")

    _locale: Locale
    _ts_dir: Path
    _zh_entries: dict[MessageId, str]
    _en_entries: dict[MessageId, str]
    _fallback: dict[MessageId, str]

    def __init__(
        self, ts_dir: Path = DEFAULT_TS_DIR, locale: Locale = Locale.ZH_CN
    ) -> None:
        """Load both locale catalogs and select the rendering locale."""
        self._ts_dir = ts_dir
        self._locale = locale
        self._zh_entries = _load_catalog(_catalog_path(ts_dir, Locale.ZH_CN))
        self._en_entries = _load_catalog(_catalog_path(ts_dir, Locale.EN_US))
        self._fallback = self._en_entries

    @property
    def locale(self) -> Locale:
        """Return the currently selected locale."""
        return self._locale

    def with_locale(self, locale: Locale) -> MessageCatalog:
        """Return a new catalog rendering the requested locale."""
        return MessageCatalog(ts_dir=self._ts_dir, locale=locale)

    def _entries_for(self, locale: Locale) -> dict[MessageId, str]:
        """Return the parsed entry table for one locale."""
        match locale:
            case Locale.ZH_CN:
                return self._zh_entries
            case Locale.EN_US:
                return self._en_entries

    def raw_message(self, message_id: str) -> str:
        """Resolve a message ID to its template with deterministic fallback.

        Lookup order is current locale, then the fallback locale, then the
        message ID itself, so the result is never empty or a generic error
        phrase even when the ID is unknown to both catalogs.
        """
        direct = self._entries_for(self._locale).get(MessageId(message_id))
        if direct is not None:
            return direct
        fallback = self._fallback.get(MessageId(message_id))
        if fallback is not None:
            return fallback
        return message_id

    def format_message(
        self,
        message_id: str,
        params: dict[str, str | int | float] | None = None,
    ) -> str:
        """Render a localized message by ID with safe literal parameters.

        This is the single UI-facing formatting entry point; display code must
        never concatenate localized fragments or embed raw exception text.
        """
        template = self.raw_message(message_id)
        return format_template(template, params or {}, message_id=message_id)

    def format_plural_message(
        self,
        message_id: str,
        count: int,
        params: dict[str, str | int | float] | None = None,
    ) -> str:
        """Render a localized plural-capable message for one count value.

        A ``|``-separated template picks the singular/plural form first, then
        the count is supplied as a literal ``{count}`` parameter; the result
        is never re-interpreted as format syntax.
        """
        template = self.raw_message(message_id)
        form = format_plural(template, count)
        combined = dict(params or {})
        combined["count"] = count
        return format_template(form, combined, message_id=message_id)

    def missing_ids(self) -> tuple[MessageId, ...]:
        """Return every required ID absent from the current locale catalog."""
        return tuple(
            message_id
            for message_id in required_message_ids()
            if message_id not in self._entries_for(self._locale)
        )

    def message_present(self, message_id: str, locale: Locale) -> bool:
        """Return whether one locale's own table holds a message by ID.

        Unlike :meth:`raw_message`, this never consults the fallback locale,
        so coverage checks can prove each locale is independently complete.
        """
        return MessageId(message_id) in self._entries_for(locale)


def check_catalog_coverage(
    zh_catalog: MessageCatalog,
    en_catalog: MessageCatalog,
    message_ids: tuple[MessageId, ...],
) -> tuple[str, ...]:
    """Return the message IDs missing from either locale's own catalog table.

    Each locale is checked independently against its own parsed entries, so a
    key present only in the fallback catalog is still reported missing for the
    other locale. Missing IDs are reported by their stable machine key, never
    by rendered prose or raw values.
    """
    missing: list[str] = []
    for message_id in message_ids:
        in_zh = zh_catalog.message_present(message_id, Locale.ZH_CN)
        in_en = en_catalog.message_present(message_id, Locale.EN_US)
        if not in_zh or not in_en:
            missing.append(message_id)
    return tuple(missing)


__all__ = [
    "DEFAULT_TS_DIR",
    "FALLBACK_LOCALE",
    "MessageCatalog",
    "check_catalog_coverage",
    "format_plural",
    "required_message_ids",
]
