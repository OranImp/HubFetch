"""Tests for strict, versioned, non-secret settings."""

from __future__ import annotations

from pathlib import Path

import pytest

from hubfetch.config.bootstrap import (
    InvalidSchemaVersionError,
    SettingsValidationError,
    parse_settings,
)
from hubfetch.config.settings import (
    CURRENT_SCHEMA_VERSION,
    DEFAULT_MANUAL_PROXY_URL,
    Settings,
)


def test_settings_have_the_locked_non_secret_defaults() -> None:
    """Given defaults, settings use Simplified Chinese and the proxy seed."""
    settings = Settings()

    assert settings.schema_version == CURRENT_SCHEMA_VERSION
    assert settings.locale == "zh_CN"
    assert settings.manual_proxy_url == DEFAULT_MANUAL_PROXY_URL
    assert settings.theme.value == "system"


def test_settings_reject_unknown_fields_at_the_boundary() -> None:
    """Given an unknown field, parsing returns a typed validation error."""
    with pytest.raises(SettingsValidationError) as caught:
        _ = parse_settings({"token": "not-persisted"})

    assert any(detail.field_name == "token" for detail in caught.value.details)
    assert "not-persisted" not in str(caught.value)


def test_settings_reject_invalid_proxy_url_at_the_boundary() -> None:
    """Given an unsupported proxy URL, parsing returns a typed validation error."""
    with pytest.raises(SettingsValidationError) as caught:
        _ = parse_settings({"manual_proxy_url": "ftp://proxy.invalid"})

    assert any(
        detail.field_name == "manual_proxy_url" for detail in caught.value.details
    )
    assert "proxy.invalid" not in str(caught.value)


def test_settings_reject_invalid_help_url_at_the_boundary() -> None:
    """Given a URL with userinfo, parsing returns a typed validation error."""
    with pytest.raises(SettingsValidationError) as caught:
        _ = parse_settings({"help_url": "https://user@example.com/releases"})

    assert any(detail.field_name == "help_url" for detail in caught.value.details)


def test_settings_reject_unknown_schema_versions() -> None:
    """Given an unknown schema version, parsing raises a typed version error."""
    with pytest.raises(InvalidSchemaVersionError) as caught:
        _ = parse_settings({"schema_version": 99})

    assert caught.value.received_version == 99
    assert caught.value.expected_version == CURRENT_SCHEMA_VERSION


def test_settings_model_has_no_secret_field_names() -> None:
    """Given the settings model, credential-like field names are absent."""
    forbidden = {"token", "password", "secret", "api_key"}

    assert forbidden.isdisjoint(Settings.model_fields)


def test_settings_do_not_read_arbitrary_environment_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Given unrelated environment values, settings retain their declared defaults."""
    monkeypatch.setenv("HUBFETCH_LOCALE", "en_US")

    assert Settings().locale == "zh_CN"


def test_settings_validate_path_overrides() -> None:
    """Given a cache path override, parsing produces a typed path value."""
    settings = parse_settings({"cache_path_overrides": {"hub_cache": "C:/hub-cache"}})

    assert settings.cache_path_overrides.hub_cache == Path("C:/hub-cache")
