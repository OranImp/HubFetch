"""Settings work surface with typed round-trip persistence.

Edits locale, theme, reduced-motion override, default auth source and
credential alias, per-kind destination defaults, proxy mode and manual URL,
cache overrides, and the optional private releases/help URL. Only Todo 2
settings plus the non-secret default alias leave the view; secrets never enter
the form. Locale, theme, and reduced motion apply immediately on change, while
Save persists through the injected sinks. Section widgets live in
:mod:`.sections` and the save/validate boundary in :mod:`.persistence`; this
module re-exports the surface's public contract.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, final

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.config.settings import (
    Locale,
    ProxyMode,
    Settings,
    TaskKind,
    Theme,
)
from hubfetch.ui import tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.common import apply_panel, semantic_colors

from . import persistence, sections, theme
from .form import SettingsEdit, SettingsForm
from .texts import SettingsViewTexts

if TYPE_CHECKING:
    from collections.abc import Callable

    from hubfetch.ui.widgets.fields import PathField, ProxyField, TextField
    from hubfetch.ui.widgets.segmented import SegmentedControl
    from hubfetch.ui.widgets.toggles import ToggleField

__all__ = ["SettingsEdit", "SettingsForm", "SettingsView", "SettingsViewTexts"]


@final
class SettingsView(QWidget):
    """A scrollable settings form persisting only Todo 2 settings and aliases."""

    settings_saved = Signal(object)  # carries Settings
    locale_changed = Signal(str)  # carries Locale.value
    theme_changed = Signal(str)  # carries Theme.value
    motion_changed = Signal(str)  # carries MotionPreference.value

    _texts: SettingsViewTexts
    _settings: Settings
    _save_settings: Callable[[Settings], None] | None
    _alias_saver: Callable[[str | None], None] | None
    _apply_theme: Callable[[Theme], None] | None
    _locale: Locale
    _theme: Theme
    _motion: tokens.MotionPreference
    _locale_control: SegmentedControl
    _theme_control: SegmentedControl
    _auth_source_control: SegmentedControl
    _proxy_mode_control: SegmentedControl
    _motion_toggle: ToggleField
    _alias_field: TextField
    _proxy_url_field: ProxyField
    _hub_cache_field: PathField
    _xet_cache_field: PathField
    _help_url_field: TextField
    _destination_fields: dict[TaskKind, PathField]
    _save: ActionButton
    _headings: sections.HeaderRegistry

    def __init__(
        self,
        texts: SettingsViewTexts,
        *,
        settings: Settings,
        save_settings: Callable[[Settings], None] | None = None,
        alias_saver: Callable[[str | None], None] | None = None,
        apply_theme: Callable[[Theme], None] | None = None,
    ) -> None:
        """Compose the scrollable form and bind every live-apply signal."""
        super().__init__()
        self._texts = texts
        self._settings = settings
        self._save_settings = save_settings
        self._alias_saver = alias_saver
        self._apply_theme = apply_theme
        self._locale = settings.locale
        self._theme = settings.theme
        self._motion = tokens.MotionPreference.FULL
        self._headings = sections.HeaderRegistry()
        self.setAccessibleName(texts.title)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(
            tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG, tokens.SPACE_LG
        )
        outer.setSpacing(tokens.SPACE_MD)
        outer.addWidget(self._build_header())
        scroll, controls = self._build_scroll()
        self._locale_control = controls.locale
        self._theme_control = controls.theme
        self._auth_source_control = controls.auth_source
        self._proxy_mode_control = controls.proxy_mode
        self._motion_toggle = controls.motion_toggle
        self._alias_field = controls.alias_field
        self._proxy_url_field = controls.proxy_url_field
        self._hub_cache_field = controls.hub_cache_field
        self._xet_cache_field = controls.xet_cache_field
        self._help_url_field = controls.help_url_field
        self._destination_fields = controls.destination_fields
        outer.addWidget(scroll, stretch=1)
        self._sync_proxy_field(settings.proxy_mode.value)
        footer = QHBoxLayout()
        footer.setSpacing(tokens.SPACE_SM)
        footer.addStretch(1)
        self._save = ActionButton(texts.save_command, primary=True)
        _ = self._save.clicked.connect(self.save)
        footer.addWidget(self._save)
        outer.addLayout(footer)
        colors = semantic_colors(self.palette())
        apply_panel(self, colors.border, colors.window)
        self._bind_live_signals()

    def _build_header(self) -> QLabel:
        """Create the bold surface title."""
        title = QLabel(self._texts.title)
        font = title.font()
        font.setBold(True)
        title.setFont(font)
        self._headings.headers.append(title)
        return title

    def _build_scroll(self) -> tuple[QScrollArea, sections.SettingsControls]:
        """Build the single scroll owner and return every settings control."""
        return sections.build_scroll(self, self._texts, self._settings, self._headings)

    def _bind_live_signals(self) -> None:
        """Apply locale, theme, and motion immediately on every change."""
        _ = self._locale_control.currentChanged.connect(self._on_locale_changed)
        _ = self._theme_control.currentChanged.connect(self._on_theme_changed)
        _ = self._motion_toggle.box().toggled.connect(self._on_motion_toggled)
        _ = self._proxy_mode_control.currentChanged.connect(self._sync_proxy_field)

    def _on_locale_changed(self, raw: str) -> None:
        """Swap the vocabulary and re-render every heading immediately."""
        self._locale = Locale(raw)
        self._texts = SettingsViewTexts.for_locale(self._locale)
        self._refresh_labels()
        self.locale_changed.emit(raw)

    def _on_theme_changed(self, raw: str) -> None:
        """Apply the new theme palette to the application immediately."""
        self._theme = Theme(raw)
        applier = (
            self._apply_theme if self._apply_theme is not None else theme.apply_theme
        )
        applier(self._theme)
        self.theme_changed.emit(raw)

    def _on_motion_toggled(self, checked: bool) -> None:
        """Store the session override and announce the motion preference."""
        self._motion = (
            tokens.MotionPreference.REDUCED if checked else tokens.MotionPreference.FULL
        )
        self.motion_changed.emit(self._motion.value)

    def _sync_proxy_field(self, raw: str) -> None:
        """Enable the manual proxy editor only for manual mode."""
        manual = ProxyMode(raw) is ProxyMode.MANUAL
        reason = None if manual else self._texts.proxy_url_label
        self._proxy_url_field.set_disabled_reason(reason)

    def _refresh_labels(self) -> None:
        """Re-render heading and command text from the current vocabulary."""
        texts = self._texts
        self._headings.headers[0].setText(texts.title)
        self._save.setText(texts.save_command)
        self._save.setAccessibleName(texts.save_command)
        for key, label in self._headings.section_headers.items():
            label.setText(key)

    def texts(self) -> SettingsViewTexts:
        """Return the vocabulary active in this view."""
        return self._texts

    def current_locale(self) -> Locale:
        """Return the currently selected locale."""
        return self._locale

    def current_theme(self) -> Theme:
        """Return the currently selected theme."""
        return self._theme

    def current_motion(self) -> tokens.MotionPreference:
        """Return the currently active motion preference."""
        return self._motion

    def locale_control(self) -> SegmentedControl:
        """Return the locale segmented control."""
        return self._locale_control

    def theme_control(self) -> SegmentedControl:
        """Return the theme segmented control."""
        return self._theme_control

    def auth_source_control(self) -> SegmentedControl:
        """Return the default auth source segmented control."""
        return self._auth_source_control

    def proxy_mode_control(self) -> SegmentedControl:
        """Return the proxy mode segmented control."""
        return self._proxy_mode_control

    def motion_toggle(self) -> ToggleField:
        """Return the reduced-motion toggle."""
        return self._motion_toggle

    def alias_field(self) -> TextField:
        """Return the default credential alias field."""
        return self._alias_field

    def proxy_url_field(self) -> ProxyField:
        """Return the manual proxy URL field."""
        return self._proxy_url_field

    def hub_cache_field(self) -> PathField:
        """Return the hub cache override field."""
        return self._hub_cache_field

    def xet_cache_field(self) -> PathField:
        """Return the xet cache override field."""
        return self._xet_cache_field

    def help_url_field(self) -> TextField:
        """Return the optional help URL field."""
        return self._help_url_field

    def destination_field(self, kind: TaskKind) -> PathField:
        """Return the default destination field for one task kind."""
        return self._destination_fields[kind]

    def save_button(self) -> ActionButton:
        """Return the primary Save command."""
        return self._save

    def current_form(self) -> SettingsForm:
        """Return the current non-secret form state without persisting."""
        return persistence.current_form(self)

    def save(self) -> SettingsEdit | None:
        """Validate the form, persist only settings and the alias, or return None."""
        form = persistence.current_form(self)
        if not persistence.validate_form(self, form):
            return None
        updated = persistence.build_updated_settings(self._settings, form)
        edit = SettingsEdit(
            settings=updated, default_credential_alias=form.default_credential_alias
        )
        if self._save_settings is not None:
            self._save_settings(updated)
        if self._alias_saver is not None:
            self._alias_saver(form.default_credential_alias)
        self.settings_saved.emit(updated)
        return edit
