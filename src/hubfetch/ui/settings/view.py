# noqa: SIZE_OK - one module must own the whole settings surface: the bilingual
# vocabulary, the editable form model, every section's widgets, immediate
# locale/theme/motion application, and the save/validate boundary; splitting it
# would scatter one cohesive form across modules.

"""Settings work surface with typed round-trip persistence.

Edits locale, theme, reduced-motion override, default auth source and
credential alias, per-kind destination defaults, proxy mode and manual URL,
cache overrides, and the optional private releases/help URL. Only Todo 2
settings plus the non-secret default alias leave the view; secrets never enter
the form. Locale, theme, and reduced motion apply immediately on change, while
Save persists through the injected sinks.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, final

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QPalette
from PySide6.QtWidgets import (
    QApplication,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from hubfetch.config.bootstrap import validate_config_path, validate_http_url
from hubfetch.config.settings import (
    AuthSource,
    CachePathOverrides,
    Locale,
    ProxyMode,
    Settings,
    TaskKind,
    Theme,
)
from hubfetch.credentials.models import parse_credential_alias
from hubfetch.ui import style as ui_style
from hubfetch.ui import tokens
from hubfetch.ui.widgets.buttons import ActionButton
from hubfetch.ui.widgets.common import apply_panel, semantic_colors
from hubfetch.ui.widgets.fields import PathField, ProxyField, TextField
from hubfetch.ui.widgets.segmented import Segment, SegmentedControl
from hubfetch.ui.widgets.toggles import ToggleField

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ["SettingsEdit", "SettingsForm", "SettingsView", "SettingsViewTexts"]


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


@dataclass(frozen=True, slots=True)
class _SettingsControls:
    """Every editable control returned by the form builder."""

    locale: SegmentedControl
    theme: SegmentedControl
    auth_source: SegmentedControl
    proxy_mode: SegmentedControl
    motion_toggle: ToggleField
    alias_field: TextField
    proxy_url_field: ProxyField
    hub_cache_field: PathField
    xet_cache_field: PathField
    help_url_field: TextField
    destination_fields: dict[TaskKind, PathField]


@dataclass(frozen=True, slots=True)
class SettingsViewTexts:
    """Bilingual vocabulary for the Settings surface, resolved by locale."""

    title: str
    appearance_section: str
    locale_label: str
    theme_label: str
    reduced_motion_label: str
    reduced_motion_description: str
    defaults_section: str
    auth_source_label: str
    alias_label: str
    alias_placeholder: str
    destinations_section: str
    network_section: str
    proxy_mode_label: str
    proxy_url_label: str
    storage_section: str
    hub_cache_label: str
    xet_cache_label: str
    advanced_section: str
    help_url_label: str
    help_url_placeholder: str
    save_command: str
    locale_zh: str
    locale_en: str
    theme_system: str
    theme_light: str
    theme_dark: str
    auth_anonymous: str
    auth_browser: str
    auth_manual: str
    proxy_system: str
    proxy_direct: str
    proxy_manual: str
    destination_labels: dict[TaskKind, str]

    @classmethod
    def for_locale(cls, locale: Locale) -> SettingsViewTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return SettingsViewTexts(
                title="Settings",
                appearance_section="Appearance",
                locale_label="Language",
                theme_label="Theme",
                reduced_motion_label="Reduce motion",
                reduced_motion_description="Disable non-essential animation",
                defaults_section="Defaults",
                auth_source_label="Default authentication",
                alias_label="Default credential alias",
                alias_placeholder="hfc-<32 hex characters>",
                destinations_section="Default destinations",
                network_section="Network",
                proxy_mode_label="Proxy mode",
                proxy_url_label="Manual proxy URL",
                storage_section="Storage",
                hub_cache_label="Hub cache override",
                xet_cache_label="Xet cache override",
                advanced_section="Advanced",
                help_url_label="Private releases / Help URL",
                help_url_placeholder="https://",
                save_command="Save settings",
                locale_zh="简体中文",
                locale_en="English",
                theme_system="System",
                theme_light="Light",
                theme_dark="Dark",
                auth_anonymous="Anonymous",
                auth_browser="Shared browser",
                auth_manual="HubFetch token",
                proxy_system="System",
                proxy_direct="Direct",
                proxy_manual="Manual",
                destination_labels={
                    TaskKind.MODEL: "Model destination",
                    TaskKind.DATASET: "Dataset destination",
                    TaskKind.SPACE: "Space destination",
                    TaskKind.CLONE: "Clone destination",
                },
            )
        return SettingsViewTexts(
            title="设置",
            appearance_section="外观",
            locale_label="语言",
            theme_label="主题",
            reduced_motion_label="减少动态效果",
            reduced_motion_description="关闭非必要的动画",
            defaults_section="默认值",
            auth_source_label="默认身份验证",
            alias_label="默认凭据别名",
            alias_placeholder="hfc-<32 位十六进制字符>",
            destinations_section="默认目标目录",
            network_section="网络",
            proxy_mode_label="代理模式",
            proxy_url_label="手动代理 URL",
            storage_section="存储",
            hub_cache_label="Hub 缓存覆盖",
            xet_cache_label="Xet 缓存覆盖",
            advanced_section="高级",
            help_url_label="私有发布 / 帮助 URL",
            help_url_placeholder="https://",
            save_command="保存设置",
            locale_zh="简体中文",
            locale_en="English",
            theme_system="跟随系统",
            theme_light="浅色",
            theme_dark="深色",
            auth_anonymous="匿名",
            auth_browser="共享浏览器登录",
            auth_manual="HubFetch 令牌",
            proxy_system="系统",
            proxy_direct="直连",
            proxy_manual="手动",
            destination_labels={
                TaskKind.MODEL: "模型目标目录",
                TaskKind.DATASET: "数据集目标目录",
                TaskKind.SPACE: "应用目标目录",
                TaskKind.CLONE: "克隆目标目录",
            },
        )


def _palette_for(theme: Theme) -> QPalette:
    """Resolve the locked light/dark/system palette for one theme choice."""
    app = QApplication.instance()
    if theme is Theme.SYSTEM and isinstance(app, QApplication):
        if app.styleHints().colorScheme() is Qt.ColorScheme.Dark:
            return ui_style.build_dark_palette()
        return ui_style.build_light_palette()
    if theme is Theme.LIGHT:
        return ui_style.build_light_palette()
    return ui_style.build_dark_palette()


def _apply_theme(theme: Theme) -> None:
    """Apply one theme to the whole application palette immediately."""
    app = QApplication.instance()
    if isinstance(app, QApplication):
        app.setPalette(_palette_for(theme))


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
    _headers: list[QLabel]
    _section_headers: dict[str, QLabel]

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
        self._headers = []
        self._section_headers = {}
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
        self._headers.append(title)
        return title

    def _build_scroll(self) -> tuple[QScrollArea, _SettingsControls]:
        """Build the single scroll owner and return every settings control."""
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setMinimumSize(0, 0)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        content = QWidget()
        layout = QVBoxLayout(content)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(tokens.SPACE_MD)
        locale_control, theme_control, motion_toggle = self._build_appearance(layout)
        (
            auth_source_control,
            alias_field,
            destination_fields,
        ) = self._build_defaults(layout)
        proxy_mode_control, proxy_url_field = self._build_network(layout)
        (
            hub_cache_field,
            xet_cache_field,
            help_url_field,
        ) = self._build_storage_and_advanced(layout)
        layout.addStretch(1)
        scroll.setWidget(content)
        return scroll, _SettingsControls(
            locale=locale_control,
            theme=theme_control,
            auth_source=auth_source_control,
            proxy_mode=proxy_mode_control,
            motion_toggle=motion_toggle,
            alias_field=alias_field,
            proxy_url_field=proxy_url_field,
            hub_cache_field=hub_cache_field,
            xet_cache_field=xet_cache_field,
            help_url_field=help_url_field,
            destination_fields=destination_fields,
        )

    def _build_appearance(
        self, layout: QVBoxLayout
    ) -> tuple[SegmentedControl, SegmentedControl, ToggleField]:
        """Build the locale, theme, and reduced-motion controls."""
        texts = self._texts
        locale_control = self._add_segmented(
            layout,
            texts.appearance_section,
            texts.locale_label,
            (
                Segment(Locale.ZH_CN.value, texts.locale_zh),
                Segment(Locale.EN_US.value, texts.locale_en),
            ),
        )
        theme_control = self._add_segmented(
            layout,
            "",
            texts.theme_label,
            (
                Segment(Theme.SYSTEM.value, texts.theme_system),
                Segment(Theme.LIGHT.value, texts.theme_light),
                Segment(Theme.DARK.value, texts.theme_dark),
            ),
        )
        locale_control.set_current(self._locale.value)
        theme_control.set_current(self._theme.value)
        motion_toggle = ToggleField(
            texts.reduced_motion_label, texts.reduced_motion_description
        )
        layout.addWidget(motion_toggle)
        return locale_control, theme_control, motion_toggle

    def _build_defaults(
        self, layout: QVBoxLayout
    ) -> tuple[SegmentedControl, TextField, dict[TaskKind, PathField]]:
        """Build the auth source, alias, and destination default fields."""
        texts = self._texts
        self._add_section_header(layout, texts.defaults_section)
        auth_source_control = self._add_segmented(
            layout,
            "",
            texts.auth_source_label,
            (
                Segment(AuthSource.ANONYMOUS.value, texts.auth_anonymous),
                Segment(AuthSource.BROWSER.value, texts.auth_browser),
                Segment(AuthSource.MANUAL.value, texts.auth_manual),
            ),
        )
        auth_source_control.set_current(self._settings.default_auth_source.value)
        alias_field = TextField(texts.alias_label, placeholder=texts.alias_placeholder)
        layout.addWidget(alias_field)
        self._add_section_header(layout, texts.destinations_section)
        destination_fields: dict[TaskKind, PathField] = {}
        for kind in TaskKind:
            field = PathField(texts.destination_labels[kind])
            existing = self._settings.default_destinations.get(kind)
            if existing is not None:
                field.set_text(str(existing))
            destination_fields[kind] = field
            layout.addWidget(field)
        return auth_source_control, alias_field, destination_fields

    def _build_network(
        self, layout: QVBoxLayout
    ) -> tuple[SegmentedControl, ProxyField]:
        """Build the proxy mode and manual URL controls."""
        texts = self._texts
        self._add_section_header(layout, texts.network_section)
        proxy_mode_control = self._add_segmented(
            layout,
            "",
            texts.proxy_mode_label,
            (
                Segment(ProxyMode.SYSTEM.value, texts.proxy_system),
                Segment(ProxyMode.DIRECT.value, texts.proxy_direct),
                Segment(ProxyMode.MANUAL.value, texts.proxy_manual),
            ),
        )
        proxy_mode_control.set_current(self._settings.proxy_mode.value)
        proxy_url_field = ProxyField(texts.proxy_url_label)
        proxy_url_field.set_text(self._settings.manual_proxy_url)
        layout.addWidget(proxy_url_field)
        return proxy_mode_control, proxy_url_field

    def _build_storage_and_advanced(
        self, layout: QVBoxLayout
    ) -> tuple[PathField, PathField, TextField]:
        """Build the cache override and help URL fields."""
        texts = self._texts
        self._add_section_header(layout, texts.storage_section)
        hub_cache_field = PathField(texts.hub_cache_label)
        hub_override = self._settings.cache_path_overrides.hub_cache
        if hub_override is not None:
            hub_cache_field.set_text(str(hub_override))
        layout.addWidget(hub_cache_field)
        xet_cache_field = PathField(texts.xet_cache_label)
        xet_override = self._settings.cache_path_overrides.xet_cache
        if xet_override is not None:
            xet_cache_field.set_text(str(xet_override))
        layout.addWidget(xet_cache_field)
        self._add_section_header(layout, texts.advanced_section)
        help_url_field = TextField(
            texts.help_url_label, placeholder=texts.help_url_placeholder
        )
        if self._settings.help_url is not None:
            help_url_field.set_text(self._settings.help_url)
        layout.addWidget(help_url_field)
        return hub_cache_field, xet_cache_field, help_url_field

    def _add_section_header(self, layout: QVBoxLayout, label_text: str) -> None:
        """Add one section heading whose text re-renders on locale change."""
        label = QLabel(label_text)
        font = label.font()
        font.setWeight(QFont.Weight.DemiBold)
        label.setFont(font)
        self._headers.append(label)
        self._section_headers[label_text] = label
        layout.addWidget(label)

    def _add_segmented(
        self,
        layout: QVBoxLayout,
        section_label: str,
        label_text: str,
        segments: tuple[Segment, ...],
    ) -> SegmentedControl:
        """Add one labeled segmented control and return it."""
        if section_label:
            self._add_section_header(layout, section_label)
        label = QLabel(label_text)
        self._headers.append(label)
        layout.addWidget(label)
        control = SegmentedControl(label_text, segments)
        layout.addWidget(control)
        return control

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
        applier = self._apply_theme if self._apply_theme is not None else _apply_theme
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
        self._headers[0].setText(texts.title)
        self._save.setText(texts.save_command)
        self._save.setAccessibleName(texts.save_command)
        for key, label in self._section_headers.items():
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
        return SettingsForm(
            locale=self._locale,
            theme=self._theme,
            reduced_motion=self._motion is tokens.MotionPreference.REDUCED,
            default_auth_source=AuthSource(self._auth_source_control.current_key()),
            default_credential_alias=self._optional_alias(),
            default_destinations={
                kind: field.editor().text().strip()
                for kind, field in self._destination_fields.items()
            },
            proxy_mode=ProxyMode(self._proxy_mode_control.current_key()),
            manual_proxy_url=self._proxy_url_field.editor().text().strip(),
            hub_cache_override=self._hub_cache_field.editor().text().strip(),
            xet_cache_override=self._xet_cache_field.editor().text().strip(),
            help_url=self._help_url_field.editor().text().strip(),
        )

    def save(self) -> SettingsEdit | None:
        """Validate the form, persist only settings and the alias, or return None."""
        form = self.current_form()
        if not self._validate(form):
            return None
        destinations = {
            kind: validate_config_path(raw, f"destination.{kind.value}")
            for kind, raw in form.default_destinations.items()
            if raw
        }
        updated = self._settings.model_copy(
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
        edit = SettingsEdit(
            settings=updated, default_credential_alias=form.default_credential_alias
        )
        if self._save_settings is not None:
            self._save_settings(updated)
        if self._alias_saver is not None:
            self._alias_saver(form.default_credential_alias)
        self.settings_saved.emit(updated)
        return edit

    def _validate(self, form: SettingsForm) -> bool:
        """Show inline errors for invalid URLs, paths, and aliases."""
        valid = True
        if form.help_url:
            try:
                _ = validate_http_url(form.help_url, "help_url")
                self._help_url_field.set_error(None)
            except ValueError as error:
                self._help_url_field.set_error(str(error))
                valid = False
        else:
            self._help_url_field.set_error(None)
        if form.proxy_mode is ProxyMode.MANUAL:
            try:
                _ = validate_http_url(form.manual_proxy_url, "manual_proxy_url")
                self._proxy_url_field.set_error(None)
            except ValueError as error:
                self._proxy_url_field.set_error(str(error))
                valid = False
        else:
            self._proxy_url_field.set_error(None)
        alias = form.default_credential_alias
        if alias:
            try:
                _ = parse_credential_alias(alias)
                self._alias_field.set_error(None)
            except ValueError as error:
                self._alias_field.set_error(str(error))
                valid = False
        else:
            self._alias_field.set_error(None)
        for kind, raw in form.default_destinations.items():
            if raw:
                try:
                    _ = validate_config_path(raw, f"destination.{kind.value}")
                except ValueError as error:
                    self._destination_fields[kind].set_error(str(error))
                    valid = False
        return valid

    def _optional_alias(self) -> str | None:
        """Return the alias field value, or None when left empty."""
        raw = self._alias_field.editor().text().strip()
        return raw or None
