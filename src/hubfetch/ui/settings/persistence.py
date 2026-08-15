"""Save/validate boundary for the Settings surface.

Only Todo 2 settings plus the non-secret default alias leave the view; secrets
never enter the form. This module reads the current form state through the
page's public accessors, validates every URL/alias/path at the save boundary,
and builds the updated settings object. Persisting the result stays on the view.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from hubfetch.config.bootstrap import validate_config_path, validate_http_url
from hubfetch.config.settings import (
    AuthSource,
    CachePathOverrides,
    ProxyMode,
    Settings,
    TaskKind,
)
from hubfetch.credentials.models import parse_credential_alias
from hubfetch.ui import tokens

from .form import SettingsForm

if TYPE_CHECKING:
    from hubfetch.config.settings import Locale, Theme
    from hubfetch.ui.widgets.fields import PathField, ProxyField, TextField
    from hubfetch.ui.widgets.segmented import SegmentedControl

__all__ = [
    "SettingsViewFields",
    "build_updated_settings",
    "current_form",
    "optional_alias",
    "validate_form",
]


class SettingsViewFields(Protocol):
    """The read-only accessors the save boundary needs from the settings page."""

    def current_locale(self) -> Locale:
        """Return the currently selected locale."""
        ...

    def current_theme(self) -> Theme:
        """Return the currently selected theme."""
        ...

    def current_motion(self) -> tokens.MotionPreference:
        """Return the currently active motion preference."""
        ...

    def auth_source_control(self) -> SegmentedControl:
        """Return the default auth source segmented control."""
        ...

    def alias_field(self) -> TextField:
        """Return the default credential alias field."""
        ...

    def destination_field(self, kind: TaskKind) -> PathField:
        """Return the default destination field for one task kind."""
        ...

    def proxy_mode_control(self) -> SegmentedControl:
        """Return the proxy mode segmented control."""
        ...

    def proxy_url_field(self) -> ProxyField:
        """Return the manual proxy URL field."""
        ...

    def hub_cache_field(self) -> PathField:
        """Return the hub cache override field."""
        ...

    def xet_cache_field(self) -> PathField:
        """Return the xet cache override field."""
        ...

    def help_url_field(self) -> TextField:
        """Return the optional help URL field."""
        ...


def current_form(view: SettingsViewFields) -> SettingsForm:
    """Return the current non-secret form state without persisting."""
    return SettingsForm(
        locale=view.current_locale(),
        theme=view.current_theme(),
        reduced_motion=view.current_motion() is tokens.MotionPreference.REDUCED,
        default_auth_source=AuthSource(view.auth_source_control().current_key()),
        default_credential_alias=optional_alias(view.alias_field()),
        default_destinations={
            kind: view.destination_field(kind).editor().text().strip()
            for kind in TaskKind
        },
        proxy_mode=ProxyMode(view.proxy_mode_control().current_key()),
        manual_proxy_url=view.proxy_url_field().editor().text().strip(),
        hub_cache_override=view.hub_cache_field().editor().text().strip(),
        xet_cache_override=view.xet_cache_field().editor().text().strip(),
        help_url=view.help_url_field().editor().text().strip(),
    )


def validate_form(view: SettingsViewFields, form: SettingsForm) -> bool:
    """Show inline errors for invalid URLs, paths, and aliases."""
    valid = True
    if form.help_url:
        try:
            _ = validate_http_url(form.help_url, "help_url")
            view.help_url_field().set_error(None)
        except ValueError as error:
            view.help_url_field().set_error(str(error))
            valid = False
    else:
        view.help_url_field().set_error(None)
    if form.proxy_mode is ProxyMode.MANUAL:
        try:
            _ = validate_http_url(form.manual_proxy_url, "manual_proxy_url")
            view.proxy_url_field().set_error(None)
        except ValueError as error:
            view.proxy_url_field().set_error(str(error))
            valid = False
    else:
        view.proxy_url_field().set_error(None)
    alias = form.default_credential_alias
    if alias:
        try:
            _ = parse_credential_alias(alias)
            view.alias_field().set_error(None)
        except ValueError as error:
            view.alias_field().set_error(str(error))
            valid = False
    else:
        view.alias_field().set_error(None)
    for kind, raw in form.default_destinations.items():
        if raw:
            try:
                _ = validate_config_path(raw, f"destination.{kind.value}")
            except ValueError as error:
                view.destination_field(kind).set_error(str(error))
                valid = False
    return valid


def build_updated_settings(settings: Settings, form: SettingsForm) -> Settings:
    """Construct the persisted settings from a validated form snapshot."""
    destinations = {
        kind: validate_config_path(raw, f"destination.{kind.value}")
        for kind, raw in form.default_destinations.items()
        if raw
    }
    return settings.model_copy(
        update={
            "locale": form.locale,
            "theme": form.theme,
            "proxy_mode": form.proxy_mode,
            "manual_proxy_url": form.manual_proxy_url,
            "cache_path_overrides": CachePathOverrides(
                hub_cache=(
                    validate_config_path(form.hub_cache_override, "hub_cache")
                    if form.hub_cache_override
                    else None
                ),
                xet_cache=(
                    validate_config_path(form.xet_cache_override, "xet_cache")
                    if form.xet_cache_override
                    else None
                ),
            ),
            "help_url": form.help_url or None,
            "default_auth_source": form.default_auth_source,
            "default_destinations": destinations,
        }
    )


def optional_alias(alias_field: TextField) -> str | None:
    """Return the alias field value, or None when left empty."""
    raw = alias_field.editor().text().strip()
    return raw or None
