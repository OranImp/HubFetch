"""Versioned, frozen, and non-secret HubFetch settings models."""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum, unique
from pathlib import Path
from typing import Annotated, ClassVar, Final, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from .paths import validate_config_path, validate_http_url

CURRENT_SCHEMA_VERSION: Final = 1
"""Current persisted settings schema version."""

DEFAULT_MANUAL_PROXY_URL: Final = "http://127.0.0.1:7897"
"""Seed value for a manually configured local HTTP proxy."""


@unique
class Theme(StrEnum):
    """Supported application theme preferences."""

    SYSTEM = "system"
    LIGHT = "light"
    DARK = "dark"


@unique
class AuthSource(StrEnum):
    """Non-secret authentication source preferences."""

    ANONYMOUS = "anonymous"
    BROWSER = "browser"
    MANUAL = "manual"


@unique
class TaskKind(StrEnum):
    """Task kinds that may have default destination directories."""

    MODEL = "model"
    DATASET = "dataset"
    SPACE = "space"
    CLONE = "clone"


@unique
class ProxyMode(StrEnum):
    """Proxy policy selected for future transfer workers."""

    SYSTEM = "system"
    DIRECT = "direct"
    MANUAL = "manual"


@unique
class Locale(StrEnum):
    """Locales supported by the initial settings contract."""

    ZH_CN = "zh_CN"
    EN_US = "en_US"


def _parse_url(value: str) -> str:
    """Validate a URL field before Pydantic stores it."""
    return validate_http_url(value, "url")


def _parse_optional_url(value: str | None) -> str | None:
    """Validate an optional URL while preserving the unset value."""
    if value is None:
        return None
    return validate_http_url(value, "url")


def _parse_path(value: str | Path) -> Path:
    """Validate a path field before Pydantic stores it."""
    return validate_config_path(value, "path")


HttpUrlValue = Annotated[str, BeforeValidator(_parse_url)]
OptionalHttpUrlValue = Annotated[str | None, BeforeValidator(_parse_optional_url)]
ConfigPathValue = Annotated[Path, BeforeValidator(_parse_path)]


class CachePathOverrides(BaseModel):
    """Optional non-secret cache locations selected by the user."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)

    hub_cache: ConfigPathValue | None = None
    xet_cache: ConfigPathValue | None = None


class Settings(BaseModel):
    """Persistable application preferences with no credential-bearing fields."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)

    schema_version: Literal[1] = CURRENT_SCHEMA_VERSION
    locale: Locale = Locale.ZH_CN
    theme: Theme = Theme.SYSTEM
    proxy_mode: ProxyMode = ProxyMode.SYSTEM
    manual_proxy_url: HttpUrlValue = DEFAULT_MANUAL_PROXY_URL
    cache_path_overrides: CachePathOverrides = Field(default_factory=CachePathOverrides)
    help_url: OptionalHttpUrlValue = None
    window_geometry: bytes | None = None
    window_state: bytes | None = None
    default_auth_source: AuthSource = AuthSource.ANONYMOUS
    default_destinations: dict[TaskKind, ConfigPathValue] = Field(default_factory=dict)


type SettingsValue = (
    str | int | float | bool | list[SettingsValue] | dict[str, SettingsValue] | None
)
type SettingsPayload = Mapping[str, SettingsValue]
