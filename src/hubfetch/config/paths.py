"""Qt-backed filesystem paths for the HubFetch application."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final, NewType, TypedDict, override
from urllib.parse import urlsplit

from PySide6.QtCore import QCoreApplication, QStandardPaths

from .identity import APP_IDENTITY, AppIdentity

HttpUrl = NewType("HttpUrl", str)


class ConfigurationError(ValueError):
    """Base class for errors raised while parsing application configuration."""


@dataclass(frozen=True, slots=True)
class InvalidUrlError(ConfigurationError):
    """A URL failed the HubFetch HTTP/HTTPS boundary contract."""

    field_name: str
    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid URL for {self.field_name}: {self.reason}"


@dataclass(frozen=True, slots=True)
class InvalidPathError(ConfigurationError):
    """A path failed the HubFetch filesystem boundary contract."""

    field_name: str
    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid path for {self.field_name}: {self.reason}"


def validate_http_url(value: str, field_name: str) -> HttpUrl:
    """Parse an HTTP(S) URL with host, optional port, and no userinfo or fragment."""
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"}:
        raise InvalidUrlError(
            field_name=field_name, reason="scheme must be HTTP or HTTPS"
        )
    try:
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError as error:
        raise InvalidUrlError(
            field_name=field_name, reason="invalid host or port"
        ) from error
    if not hostname:
        raise InvalidUrlError(field_name=field_name, reason="host is required")
    if parsed.username is not None or parsed.password is not None:
        raise InvalidUrlError(field_name=field_name, reason="userinfo is not allowed")
    if parsed.fragment:
        raise InvalidUrlError(field_name=field_name, reason="fragment is not allowed")
    return HttpUrl(value)


def validate_config_path(value: str | Path, field_name: str) -> Path:
    """Parse a non-empty path and reject embedded NUL characters."""
    match value:
        case str() as raw_path:
            if not raw_path.strip():
                raise InvalidPathError(field_name=field_name, reason="path is empty")
            if "\x00" in raw_path:
                raise InvalidPathError(
                    field_name=field_name, reason="NUL is not allowed"
                )
            return Path(raw_path)
        case Path() as path:
            if not str(path).strip():
                raise InvalidPathError(field_name=field_name, reason="path is empty")
            return path


HUBFETCH_APP_DATA_ROOT_ENV: Final = "HUBFETCH_APP_DATA_ROOT"
"""Documented test and portable-smoke override for the application data root."""


class AppPathsJson(TypedDict):
    """String form of resolved paths for smoke-test evidence and diagnostics."""

    data_root: str
    log_root: str
    cache_root: str
    credentials_root: str
    database_path: str


@dataclass(frozen=True, slots=True)
class AppPaths:
    """Resolved application directories and the database path."""

    data_root: Path
    log_root: Path
    cache_root: Path
    credentials_root: Path
    database_path: Path

    @classmethod
    def resolve(cls, identity: AppIdentity = APP_IDENTITY) -> AppPaths:
        """Resolve paths from Qt, honoring only the documented portable root."""
        override_root = os.environ.get(HUBFETCH_APP_DATA_ROOT_ENV)
        if override_root is not None:
            data_root = _portable_root(override_root)
            log_root = data_root / "logs"
            cache_root = data_root / "cache"
            credentials_root = data_root / "credentials"
        else:
            _configure_qt_identity(identity)
            data_root = _standard_location(
                QStandardPaths.StandardLocation.AppDataLocation,
                "data_root",
            )
            log_root = _standard_location(
                QStandardPaths.StandardLocation.AppLocalDataLocation,
                "log_root",
            )
            cache_root = _standard_location(
                QStandardPaths.StandardLocation.CacheLocation,
                "cache_root",
            )
            credentials_root = data_root / "credentials"
        return cls(
            data_root=data_root,
            log_root=log_root,
            cache_root=cache_root,
            credentials_root=credentials_root,
            database_path=data_root / identity.database_filename,
        )

    def as_json(self) -> AppPathsJson:
        """Return a normalized string representation without filesystem I/O."""
        return {
            "cache_root": str(self.cache_root),
            "credentials_root": str(self.credentials_root),
            "data_root": str(self.data_root),
            "database_path": str(self.database_path),
            "log_root": str(self.log_root),
        }

    def directories(self) -> tuple[Path, ...]:
        """Return directories that bootstrap must create before application use."""
        return (self.data_root, self.log_root, self.cache_root, self.credentials_root)


AppPathsResult = AppPaths
"""Named result type retained for typed bootstrap APIs."""


def resolve_app_paths(identity: AppIdentity = APP_IDENTITY) -> AppPathsResult:
    """Resolve the application paths through the canonical path boundary."""
    return AppPaths.resolve(identity)


def _configure_qt_identity(identity: AppIdentity) -> None:
    """Set Qt's organization and application names before standard-path lookup."""
    if QCoreApplication.organizationName() != identity.display_name:
        QCoreApplication.setOrganizationName(identity.display_name)
    if QCoreApplication.applicationName() != identity.display_name:
        QCoreApplication.setApplicationName(identity.display_name)


def _portable_root(raw_root: str) -> Path:
    """Parse the single documented portable root without accepting blank paths."""
    return validate_config_path(raw_root, HUBFETCH_APP_DATA_ROOT_ENV)


def _standard_location(
    location: QStandardPaths.StandardLocation,
    field_name: str,
) -> Path:
    """Read one writable Qt location and turn an empty result into a typed error."""
    raw_path = QStandardPaths.writableLocation(location)
    if not raw_path:
        raise InvalidPathError(field_name=field_name, reason="Qt returned no path")
    return Path(raw_path)
