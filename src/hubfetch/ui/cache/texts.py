"""Bilingual vocabulary for the read-only Cache surface, resolved by locale."""

from __future__ import annotations

from dataclasses import dataclass

from hubfetch.config.settings import Locale


@dataclass(frozen=True, slots=True)
class CacheViewTexts:
    """Bilingual vocabulary for the Cache surface, resolved by locale."""

    title: str
    hf_home_label: str
    hub_cache_label: str
    xet_cache_label: str
    hub_size_label: str
    repo_count_label: str
    incomplete_files_label: str
    corrupt_entries_label: str
    symlink_label: str
    free_space_label: str
    open_folder_command: str
    refresh_command: str
    symlink_ok: str
    symlink_degraded: str
    unknown_value: str

    @classmethod
    def for_locale(cls, locale: Locale) -> CacheViewTexts:
        """Return the complete vocabulary for one settings locale."""
        if locale is Locale.EN_US:
            return CacheViewTexts(
                title="Cache",
                hf_home_label="HF_HOME",
                hub_cache_label="HF_HUB_CACHE",
                xet_cache_label="HF_XET_CACHE",
                hub_size_label="Hub cache size",
                repo_count_label="Cached repositories",
                incomplete_files_label="Incomplete files",
                corrupt_entries_label="Corrupt entries",
                symlink_label="Symlink support",
                free_space_label="Volume free space",
                open_folder_command="Open Folder",
                refresh_command="Refresh",
                symlink_ok="Symlinks work on this volume",
                symlink_degraded="Symlinks degraded",
                unknown_value="Unknown",
            )
        return CacheViewTexts(
            title="缓存",
            hf_home_label="HF_HOME",
            hub_cache_label="HF_HUB_CACHE",
            xet_cache_label="HF_XET_CACHE",
            hub_size_label="Hub 缓存大小",
            repo_count_label="已缓存仓库",
            incomplete_files_label="未完成文件",
            corrupt_entries_label="损坏条目",
            symlink_label="符号链接支持",
            free_space_label="卷可用空间",
            open_folder_command="打开文件夹",
            refresh_command="刷新",
            symlink_ok="当前卷支持符号链接",
            symlink_degraded="符号链接能力受限",
            unknown_value="未知",
        )
