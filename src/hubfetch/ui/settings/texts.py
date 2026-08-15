"""Bilingual vocabulary for the Settings surface, resolved by locale."""

from __future__ import annotations

from dataclasses import dataclass

from hubfetch.config.settings import Locale, TaskKind


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
