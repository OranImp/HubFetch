# noqa: SIZE_OK - one module must enumerate the whole settings-surface contract:
# fixtures, round-trip persistence, immediate locale/theme/motion application,
# URL/alias validation, and secret absence.

"""Given/When/Then contracts for the Settings work surface.

Todo 27's Settings surface edits locale, theme, reduced-motion override, default
auth source and credential aliases, per-kind destination defaults, proxy mode
and manual URL, cache overrides, and an optional private releases/help URL.
Only Todo 2 settings plus the non-secret default alias are persisted; a typed
form state validates every URL/alias at the save boundary before the settings
object leaves the view.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from PySide6.QtCore import Qt

from hubfetch.config.bootstrap import parse_settings
from hubfetch.config.settings import (
    AuthSource,
    Locale,
    ProxyMode,
    Settings,
    TaskKind,
    Theme,
)
from hubfetch.ui import tokens
from hubfetch.ui.settings.view import SettingsForm, SettingsView, SettingsViewTexts

if TYPE_CHECKING:
    from pathlib import Path

    from PySide6.QtWidgets import QApplication
    from pytestqt.qtbot import QtBot

SENTINEL: str = "hf_test_secret_123"


def _make_view(
    qtbot: QtBot,
    *,
    settings: Settings | None = None,
    saved: list[Settings] | None = None,
    aliases: list[str | None] | None = None,
    themes: list[Theme] | None = None,
) -> SettingsView:
    """Build a settings view with recorded save/alias/theme sinks."""
    view = SettingsView(
        SettingsViewTexts.for_locale(Locale.ZH_CN),
        settings=settings if settings is not None else Settings(),
        save_settings=saved.append if saved is not None else None,
        alias_saver=aliases.append if aliases is not None else None,
        apply_theme=themes.append if themes is not None else None,
    )
    qtbot.addWidget(view)
    view.show()
    return view


def test_all_editable_settings_round_trip_except_secrets(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given every editable field changed, When saving, Then the persisted
    settings reparse to the same non-secret values with no token field."""
    view = _make_view(qtbot)

    view.locale_control().set_current(Locale.EN_US.value)
    view.theme_control().set_current(Theme.DARK.value)
    view.auth_source_control().set_current(AuthSource.MANUAL.value)
    view.alias_field().set_text("hfc-0123456789abcdef0123456789abcdef")
    view.destination_field(TaskKind.MODEL).set_text(str(tmp_path / "models"))
    view.destination_field(TaskKind.CLONE).set_text(str(tmp_path / "clones"))
    view.proxy_mode_control().set_current(ProxyMode.MANUAL.value)
    view.proxy_url_field().set_text("http://127.0.0.1:7897")
    view.hub_cache_field().set_text(str(tmp_path / "hub"))
    view.xet_cache_field().set_text(str(tmp_path / "xet"))
    view.help_url_field().set_text("https://example.com/releases")

    edit = view.save()
    assert edit is not None
    persisted = edit.settings
    loaded = parse_settings(persisted.model_dump(mode="python"))
    assert loaded == persisted
    assert persisted.locale is Locale.EN_US
    assert persisted.theme is Theme.DARK
    assert persisted.proxy_mode is ProxyMode.MANUAL
    assert persisted.default_auth_source is AuthSource.MANUAL
    assert persisted.help_url == "https://example.com/releases"
    assert persisted.cache_path_overrides.hub_cache == tmp_path / "hub"
    assert persisted.cache_path_overrides.xet_cache == tmp_path / "xet"
    assert persisted.default_destinations[TaskKind.MODEL] == tmp_path / "models"
    assert edit.default_credential_alias == "hfc-0123456789abcdef0123456789abcdef"
    payload = persisted.model_dump(mode="python")
    assert "token" not in payload
    assert "password" not in payload
    assert SENTINEL not in str(payload)


def test_save_invokes_persistence_sinks(qtbot: QtBot) -> None:
    """Given sinks, When saving, Then settings and the alias are persisted."""
    saved: list[Settings] = []
    aliases: list[str | None] = []
    view = _make_view(qtbot, saved=saved, aliases=aliases)
    view.alias_field().set_text("hfc-ffffffffffffffffffffffffffffffff")
    view.locale_control().set_current(Locale.EN_US.value)

    edit = view.save()

    assert edit is not None
    assert saved == [edit.settings]
    assert aliases == ["hfc-ffffffffffffffffffffffffffffffff"]


def test_locale_change_applies_immediately(qtbot: QtBot) -> None:
    """Given the locale segmented control, When switching to English, Then the
    view emits locale_changed and swaps its vocabulary immediately."""
    view = _make_view(qtbot)
    emitted: list[str] = []
    _ = view.locale_changed.connect(emitted.append)

    view.locale_control().set_current(Locale.EN_US.value)

    assert emitted == [Locale.EN_US.value]
    assert view.current_locale() is Locale.EN_US
    assert view.texts().save_command == "Save settings"
    assert "设置" not in view.texts().save_command


def test_theme_change_applies_immediately(qtbot: QtBot) -> None:
    """Given the theme segmented control, When selecting dark, Then theme_changed
    fires and the injected theme applier runs at once."""
    view = _make_view(qtbot)
    emitted: list[str] = []
    themes: list[Theme] = []
    view = _make_view(qtbot, themes=themes)
    _ = view.theme_changed.connect(emitted.append)

    view.theme_control().set_current(Theme.DARK.value)

    assert emitted == [Theme.DARK.value]
    assert themes == [Theme.DARK]
    assert view.current_theme() is Theme.DARK


def test_reduced_motion_override_applies_immediately(qtbot: QtBot) -> None:
    """Given the reduced-motion toggle, When checked, Then motion_changed emits
    REDUCED and the view's motion preference updates without a save."""
    view = _make_view(qtbot)
    emitted: list[str] = []
    _ = view.motion_changed.connect(emitted.append)

    view.motion_toggle().box().setChecked(True)

    assert emitted == [tokens.MotionPreference.REDUCED.value]
    assert view.current_motion() is tokens.MotionPreference.REDUCED


def test_invalid_help_url_blocks_save_with_inline_error(qtbot: QtBot) -> None:
    """Given a non-HTTP help URL, When saving, Then no settings persist and the
    help field carries an accessible inline error."""
    saved: list[Settings] = []
    view = _make_view(qtbot, saved=saved)
    view.help_url_field().set_text("ftp://example.com/file")

    edit = view.save()

    assert edit is None
    assert saved == []
    assert view.help_url_field().error_message() is not None


def test_invalid_proxy_url_blocks_save_when_manual(qtbot: QtBot) -> None:
    """Given manual proxy with a credential-bearing URL, When saving, Then the
    proxy field shows an error and nothing persists."""
    saved: list[Settings] = []
    view = _make_view(qtbot, saved=saved)
    view.proxy_mode_control().set_current(ProxyMode.MANUAL.value)
    view.proxy_url_field().set_text("http://user:pass@127.0.0.1:7897")

    edit = view.save()

    assert edit is None
    assert saved == []
    assert view.proxy_url_field().error_message() is not None


def test_invalid_credential_alias_blocks_save(qtbot: QtBot) -> None:
    """Given a non-opaque alias, When saving, Then the alias field errors and no
    settings are persisted."""
    saved: list[Settings] = []
    view = _make_view(qtbot, saved=saved)
    view.alias_field().set_text("account-name")

    edit = view.save()

    assert edit is None
    assert saved == []
    assert view.alias_field().error_message() is not None


def test_manual_proxy_url_field_enabled_only_for_manual_mode(qtbot: QtBot) -> None:
    """Given system proxy mode, When inspecting, Then the manual URL editor is
    disabled with an accessible reason; switching to manual enables it."""
    view = _make_view(qtbot)

    assert not view.proxy_url_field().editor().isEnabled()
    view.proxy_mode_control().set_current(ProxyMode.MANUAL.value)
    assert view.proxy_url_field().editor().isEnabled()


def test_save_button_is_accessible_and_primary(qtbot: QtBot) -> None:
    """Given the settings view, When inspecting the footer, Then the save command
    is a primary focused action."""
    view = _make_view(qtbot)
    button = view.save_button()
    assert button.is_primary()
    assert button.accessibleName() == view.texts().save_command


def test_current_form_reflects_edited_fields(qtbot: QtBot) -> None:
    """Given edits across sections, When reading the form, Then every non-secret
    value is present without any window geometry bytes."""
    view = _make_view(qtbot, settings=Settings(locale=Locale.EN_US))
    view.proxy_mode_control().set_current(ProxyMode.DIRECT.value)

    form: SettingsForm = view.current_form()

    assert form.locale is Locale.EN_US
    assert form.proxy_mode is ProxyMode.DIRECT
    assert form.manual_proxy_url == "http://127.0.0.1:7897"
    assert form.reduced_motion is False
    assert not any(hasattr(form, name) for name in ("window_geometry", "window_state"))


def test_escape_key_focus_flows_through_controls(
    qtbot: QtBot, qapp: QApplication
) -> None:
    """Given the settings view, When tabbing into a field, Then the editor gains
    keyboard focus with a visible focus policy."""
    view = _make_view(qtbot)
    editor = view.help_url_field().editor()
    editor.setFocus(Qt.FocusReason.TabFocusReason)
    qapp.processEvents()
    assert editor.hasFocus()
    assert editor.focusPolicy() is Qt.FocusPolicy.StrongFocus
