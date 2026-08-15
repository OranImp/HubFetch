"""Bilingual vocabulary for the Diagnostics surface, resolved by locale."""

from __future__ import annotations

from dataclasses import dataclass

from hubfetch.config.settings import Locale


@dataclass(frozen=True, slots=True)
class DiagnosticsViewTexts:
    """Bilingual vocabulary for the Diagnostics surface, resolved by locale."""

    title: str
    recheck_command: str
    copy_guidance_command: str
    export_bundle_command: str
    export_error_title: str
    export_done_title: str
    category_titles: dict[str, str]
    entry_labels: dict[str, str]
    storage_symlink_ok: str
    storage_symlink_degraded: str
    unknown_value: str
    reachable_value: str
    unreachable_value: str

    @classmethod
    def for_locale(cls, locale: Locale) -> DiagnosticsViewTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return DiagnosticsViewTexts(
                title="Diagnostics",
                recheck_command="Recheck",
                copy_guidance_command="Copy install guidance",
                export_bundle_command="Export support bundle…",
                export_error_title="Support export failed",
                export_done_title="Support bundle exported",
                category_titles={
                    "storage": "Storage",
                    "network": "Network",
                    "git": "Git and Git-Xet",
                    "credentials": "Credential helpers",
                    "keyring": "Keyring",
                    "endpoint": "Endpoint",
                    "application": "Application",
                },
                entry_labels={
                    "hf_home": "HF_HOME",
                    "hub_cache": "HF_HUB_CACHE",
                    "xet_cache": "HF_XET_CACHE",
                    "hub_cache_state": "Hub cache state",
                    "hub_size": "Hub cache size",
                    "free_space": "Free space",
                    "symlink": "Symlink support",
                    "proxy_mode": "Proxy mode",
                    "manual_proxy_url": "Manual proxy URL",
                    "git_version": "Git version",
                    "xet_version": "Git-Xet version",
                    "git_state": "Dependency state",
                    "credential_helpers": "Credential helpers",
                    "gcm": "Git Credential Manager",
                    "helper_warning": "Helper warning",
                    "backend": "Keyring backend",
                    "endpoint_url": "Endpoint",
                    "endpoint_reachability": "Reachability",
                    "package": "Package",
                    "python": "Python",
                    "platform": "Platform",
                    "architecture": "Architecture",
                    "PySide6": "PySide6",
                    "huggingface_hub": "huggingface_hub",
                    "pydantic": "pydantic",
                    "keyring": "keyring",
                },
                storage_symlink_ok="Symlinks work",
                storage_symlink_degraded="Symlinks degraded",
                unknown_value="Unknown",
                reachable_value="Reachable",
                unreachable_value="Unreachable",
            )
        return DiagnosticsViewTexts(
            title="诊断",
            recheck_command="重新检查",
            copy_guidance_command="复制安装指引",
            export_bundle_command="导出支持包…",
            export_error_title="支持包导出失败",
            export_done_title="支持包已导出",
            category_titles={
                "storage": "存储",
                "network": "网络",
                "git": "Git 与 Git-Xet",
                "credentials": "凭据助手",
                "keyring": "密钥环",
                "endpoint": "端点",
                "application": "应用程序",
            },
            entry_labels={
                "hf_home": "HF_HOME",
                "hub_cache": "HF_HUB_CACHE",
                "xet_cache": "HF_XET_CACHE",
                "hub_cache_state": "Hub 缓存状态",
                "hub_size": "Hub 缓存大小",
                "free_space": "可用空间",
                "symlink": "符号链接支持",
                "proxy_mode": "代理模式",
                "manual_proxy_url": "手动代理 URL",
                "git_version": "Git 版本",
                "xet_version": "Git-Xet 版本",
                "git_state": "依赖状态",
                "credential_helpers": "凭据助手",
                "gcm": "Git Credential Manager",
                "helper_warning": "助手警告",
                "backend": "密钥环后端",
                "endpoint_url": "端点",
                "endpoint_reachability": "可达性",
                "package": "程序包",
                "python": "Python",
                "platform": "平台",
                "architecture": "架构",
                "PySide6": "PySide6",
                "huggingface_hub": "huggingface_hub",
                "pydantic": "pydantic",
                "keyring": "keyring",
            },
            storage_symlink_ok="符号链接可用",
            storage_symlink_degraded="符号链接能力受限",
            unknown_value="未知",
            reachable_value="可达",
            unreachable_value="不可达",
        )
