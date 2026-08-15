"""Section widget builders for the Settings form.

One builder per visible section (appearance, defaults, network, storage and
advanced) plus the shared section-header/segmented helpers and the theme
palette appliers. Every heading created here lands in a shared
:class:`HeaderRegistry` so the page can re-render labels on locale change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QLabel, QScrollArea, QVBoxLayout, QWidget

from hubfetch.config.settings import (
    AuthSource,
    Locale,
    ProxyMode,
    Settings,
    TaskKind,
    Theme,
)
from hubfetch.ui import tokens
from hubfetch.ui.widgets.fields import PathField, ProxyField, TextField
from hubfetch.ui.widgets.segmented import Segment, SegmentedControl
from hubfetch.ui.widgets.toggles import ToggleField

if TYPE_CHECKING:
    from .texts import SettingsViewTexts

__all__ = ["HeaderRegistry", "build_scroll"]


class HeaderRegistry:
    """Accumulates every heading label the page must re-render on locale."""

    __slots__: Final = ("headers", "section_headers")

    def __init__(self) -> None:
        """Create the two empty heading registries."""
        self.headers: list[QLabel] = []
        self.section_headers: dict[str, QLabel] = {}


@dataclass(frozen=True, slots=True)
class SettingsControls:
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


def build_scroll(
    parent: QWidget,
    texts: SettingsViewTexts,
    settings: Settings,
    registry: HeaderRegistry,
) -> tuple[QScrollArea, SettingsControls]:
    """Build the single scroll owner and return every settings control."""
    scroll = QScrollArea(parent)
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QScrollArea.Shape.NoFrame)
    scroll.setMinimumSize(0, 0)
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
    content = QWidget()
    layout = QVBoxLayout(content)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(tokens.SPACE_MD)
    locale_control, theme_control, motion_toggle = build_appearance(
        layout, texts, settings.locale, settings.theme, registry
    )
    (
        auth_source_control,
        alias_field,
        destination_fields,
    ) = build_defaults(layout, texts, settings, registry)
    proxy_mode_control, proxy_url_field = build_network(
        layout, texts, settings, registry
    )
    (
        hub_cache_field,
        xet_cache_field,
        help_url_field,
    ) = build_storage_and_advanced(layout, texts, settings, registry)
    layout.addStretch(1)
    scroll.setWidget(content)
    return scroll, SettingsControls(
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


def build_appearance(
    layout: QVBoxLayout,
    texts: SettingsViewTexts,
    locale: Locale,
    theme: Theme,
    registry: HeaderRegistry,
) -> tuple[SegmentedControl, SegmentedControl, ToggleField]:
    """Build the locale, theme, and reduced-motion controls."""
    locale_control = add_segmented(
        layout,
        texts.appearance_section,
        texts.locale_label,
        (
            Segment(Locale.ZH_CN.value, texts.locale_zh),
            Segment(Locale.EN_US.value, texts.locale_en),
        ),
        registry,
    )
    theme_control = add_segmented(
        layout,
        "",
        texts.theme_label,
        (
            Segment(Theme.SYSTEM.value, texts.theme_system),
            Segment(Theme.LIGHT.value, texts.theme_light),
            Segment(Theme.DARK.value, texts.theme_dark),
        ),
        registry,
    )
    locale_control.set_current(locale.value)
    theme_control.set_current(theme.value)
    motion_toggle = ToggleField(
        texts.reduced_motion_label, texts.reduced_motion_description
    )
    layout.addWidget(motion_toggle)
    return locale_control, theme_control, motion_toggle


def build_defaults(
    layout: QVBoxLayout,
    texts: SettingsViewTexts,
    settings: Settings,
    registry: HeaderRegistry,
) -> tuple[SegmentedControl, TextField, dict[TaskKind, PathField]]:
    """Build the auth source, alias, and destination default fields."""
    add_section_header(layout, texts.defaults_section, registry)
    auth_source_control = add_segmented(
        layout,
        "",
        texts.auth_source_label,
        (
            Segment(AuthSource.ANONYMOUS.value, texts.auth_anonymous),
            Segment(AuthSource.BROWSER.value, texts.auth_browser),
            Segment(AuthSource.MANUAL.value, texts.auth_manual),
        ),
        registry,
    )
    auth_source_control.set_current(settings.default_auth_source.value)
    alias_field = TextField(texts.alias_label, placeholder=texts.alias_placeholder)
    layout.addWidget(alias_field)
    add_section_header(layout, texts.destinations_section, registry)
    destination_fields: dict[TaskKind, PathField] = {}
    for kind in TaskKind:
        field = PathField(texts.destination_labels[kind])
        existing = settings.default_destinations.get(kind)
        if existing is not None:
            field.set_text(str(existing))
        destination_fields[kind] = field
        layout.addWidget(field)
    return auth_source_control, alias_field, destination_fields


def build_network(
    layout: QVBoxLayout,
    texts: SettingsViewTexts,
    settings: Settings,
    registry: HeaderRegistry,
) -> tuple[SegmentedControl, ProxyField]:
    """Build the proxy mode and manual URL controls."""
    add_section_header(layout, texts.network_section, registry)
    proxy_mode_control = add_segmented(
        layout,
        "",
        texts.proxy_mode_label,
        (
            Segment(ProxyMode.SYSTEM.value, texts.proxy_system),
            Segment(ProxyMode.DIRECT.value, texts.proxy_direct),
            Segment(ProxyMode.MANUAL.value, texts.proxy_manual),
        ),
        registry,
    )
    proxy_mode_control.set_current(settings.proxy_mode.value)
    proxy_url_field = ProxyField(texts.proxy_url_label)
    proxy_url_field.set_text(settings.manual_proxy_url)
    layout.addWidget(proxy_url_field)
    return proxy_mode_control, proxy_url_field


def build_storage_and_advanced(
    layout: QVBoxLayout,
    texts: SettingsViewTexts,
    settings: Settings,
    registry: HeaderRegistry,
) -> tuple[PathField, PathField, TextField]:
    """Build the cache override and help URL fields."""
    add_section_header(layout, texts.storage_section, registry)
    hub_cache_field = PathField(texts.hub_cache_label)
    hub_override = settings.cache_path_overrides.hub_cache
    if hub_override is not None:
        hub_cache_field.set_text(str(hub_override))
    layout.addWidget(hub_cache_field)
    xet_cache_field = PathField(texts.xet_cache_label)
    xet_override = settings.cache_path_overrides.xet_cache
    if xet_override is not None:
        xet_cache_field.set_text(str(xet_override))
    layout.addWidget(xet_cache_field)
    add_section_header(layout, texts.advanced_section, registry)
    help_url_field = TextField(
        texts.help_url_label, placeholder=texts.help_url_placeholder
    )
    if settings.help_url is not None:
        help_url_field.set_text(settings.help_url)
    layout.addWidget(help_url_field)
    return hub_cache_field, xet_cache_field, help_url_field


def add_section_header(
    layout: QVBoxLayout,
    label_text: str,
    registry: HeaderRegistry,
) -> None:
    """Add one section heading whose text re-renders on locale change."""
    label = QLabel(label_text)
    font = label.font()
    font.setWeight(QFont.Weight.DemiBold)
    label.setFont(font)
    registry.headers.append(label)
    registry.section_headers[label_text] = label
    layout.addWidget(label)


def add_segmented(
    layout: QVBoxLayout,
    section_label: str,
    label_text: str,
    segments: tuple[Segment, ...],
    registry: HeaderRegistry,
) -> SegmentedControl:
    """Add one labeled segmented control and return it."""
    if section_label:
        add_section_header(layout, section_label, registry)
    label = QLabel(label_text)
    registry.headers.append(label)
    layout.addWidget(label)
    control = SegmentedControl(label_text, segments)
    layout.addWidget(control)
    return control
