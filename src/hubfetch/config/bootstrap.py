"""Typed configuration boundaries and deliberate application bootstrap."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, NewType, override

from pydantic import ValidationError

from .identity import APP_IDENTITY, AppIdentity
from .paths import (
    AppPathsResult,
    ConfigurationError,
    InvalidPathError,
    InvalidUrlError,
    resolve_app_paths,
)
from .paths import (
    validate_config_path as _validate_config_path,
)
from .paths import (
    validate_http_url as _validate_http_url,
)
from .settings import CURRENT_SCHEMA_VERSION, Settings, SettingsPayload

if TYPE_CHECKING:
    from pathlib import Path


__all__ = [
    "AppPathsResult",
    "BootstrapResult",
    "ConfigurationError",
    "InvalidPathError",
    "InvalidSchemaVersionError",
    "InvalidUrlError",
    "SettingsErrorDetail",
    "SettingsValidationError",
    "bootstrap_configuration",
    "bootstrap_paths",
    "migrate_settings_payload",
    "parse_settings",
    "validate_config_path",
    "validate_http_url",
]


HttpUrl = NewType("HttpUrl", str)


@dataclass(frozen=True, slots=True)
class InvalidSchemaVersionError(ConfigurationError):
    """A settings payload is not supported by the current migration path."""

    received_version: int | None
    expected_version: int

    @override
    def __str__(self) -> str:
        received = (
            "missing or non-integer"
            if self.received_version is None
            else str(self.received_version)
        )
        return (
            f"unsupported settings schema version {received}; "
            f"expected {self.expected_version}"
        )


@dataclass(frozen=True, slots=True)
class SettingsErrorDetail:
    """Sanitized field and error code retained from Pydantic validation."""

    field_name: str
    code: str


@dataclass(frozen=True, slots=True)
class SettingsValidationError(ConfigurationError):
    """A settings payload failed strict validation without exposing input values."""

    details: tuple[SettingsErrorDetail, ...]

    @override
    def __str__(self) -> str:
        fields = ", ".join(
            f"{detail.field_name} ({detail.code})" for detail in self.details
        )
        return f"invalid settings fields: {fields}"


def validate_http_url(value: str, field_name: str) -> HttpUrl:
    """Validate one URL at the public bootstrap boundary."""
    return HttpUrl(_validate_http_url(value, field_name))


def validate_config_path(value: str | Path, field_name: str) -> Path:
    """Validate one filesystem path at the public bootstrap boundary."""
    return _validate_config_path(value, field_name)


def migrate_settings_payload(payload: SettingsPayload) -> SettingsPayload:
    """Validate the version gate before the Pydantic parse/migration boundary."""
    raw_version = payload.get("schema_version", CURRENT_SCHEMA_VERSION)
    if isinstance(raw_version, bool) or not isinstance(raw_version, int):
        raise InvalidSchemaVersionError(
            received_version=None,
            expected_version=CURRENT_SCHEMA_VERSION,
        )
    if raw_version != CURRENT_SCHEMA_VERSION:
        raise InvalidSchemaVersionError(
            received_version=raw_version,
            expected_version=CURRENT_SCHEMA_VERSION,
        )
    return payload


def parse_settings(payload: SettingsPayload) -> Settings:
    """Parse a persisted settings payload into a strict, typed model."""
    migrated_payload = migrate_settings_payload(payload)
    try:
        return Settings.model_validate(migrated_payload)
    except ValidationError as error:
        details = tuple(
            SettingsErrorDetail(
                field_name=".".join(str(part) for part in error_detail["loc"]),
                code=error_detail["type"],
            )
            for error_detail in error.errors()
        )
        raise SettingsValidationError(details=details) from error


@dataclass(frozen=True, slots=True)
class BootstrapResult:
    """Validated settings, identity, and created application directories."""

    identity: AppIdentity
    paths: AppPathsResult
    settings: Settings


def bootstrap_paths(identity: AppIdentity = APP_IDENTITY) -> AppPathsResult:
    """Resolve and create the directories required before UI or worker startup."""
    paths = resolve_app_paths(identity)
    for directory in paths.directories():
        directory.mkdir(parents=True, exist_ok=True)
    return paths


def bootstrap_configuration(
    payload: SettingsPayload | None = None,
    identity: AppIdentity = APP_IDENTITY,
) -> BootstrapResult:
    """Validate settings and create all application directories at the boundary."""
    settings = Settings() if payload is None else parse_settings(payload)
    return BootstrapResult(
        identity=identity,
        paths=bootstrap_paths(identity),
        settings=settings,
    )
