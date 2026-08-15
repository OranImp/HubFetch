"""Editable form model for the Settings surface.

``SettingsForm`` is one snapshot of every non-secret editable field and
``SettingsEdit`` is the persisted result of a save: the settings plus the
non-secret default alias. Secrets never enter the form.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hubfetch.config.settings import (
        AuthSource,
        Locale,
        ProxyMode,
        Settings,
        TaskKind,
        Theme,
    )


@dataclass(frozen=True, slots=True)
class SettingsForm:
    """One snapshot of every non-secret editable settings field."""

    locale: Locale
    theme: Theme
    reduced_motion: bool
    default_auth_source: AuthSource
    default_credential_alias: str | None
    default_destinations: dict[TaskKind, str]
    proxy_mode: ProxyMode
    manual_proxy_url: str
    hub_cache_override: str
    xet_cache_override: str
    help_url: str


@dataclass(frozen=True, slots=True)
class SettingsEdit:
    """The persisted settings plus the non-secret default alias."""

    settings: Settings
    default_credential_alias: str | None
