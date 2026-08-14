"""Effective Hugging Face cache paths and read-only Hub cache inspection."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

import huggingface_hub
from huggingface_hub import CacheNotFound, scan_cache_dir

if TYPE_CHECKING:
    from collections.abc import Mapping

    from hubfetch.config.settings import CachePathOverrides

PINNED_HF_HUB_VERSION: Final = "1.27.0"
"""Version of huggingface_hub that the cache inspection adapter is pinned to."""

ENV_HF_HOME: Final = "HF_HOME"
ENV_HF_HUB_CACHE: Final = "HF_HUB_CACHE"
ENV_HF_XET_CACHE: Final = "HF_XET_CACHE"
ENV_XDG_CACHE_HOME: Final = "XDG_CACHE_HOME"
ENV_LEGACY_HUB_CACHE: Final = "HUGGINGFACE_HUB_CACHE"
"""Environment variable names consulted for effective cache path resolution."""


@dataclass(frozen=True, slots=True)
class CacheEnvironment:
    """Effective Hugging Face cache directories after all resolution rules."""

    hf_home: Path
    hub_cache: Path
    xet_cache: Path


@dataclass(frozen=True, slots=True)
class HubCacheScan:
    """Typed partial result of one read-only scan of the Hub cache directory."""

    cache_dir: Path
    exists: bool
    scanned: bool
    size_on_disk: int | None
    repo_count: int
    incomplete_files: int
    corrupt_entries: tuple[str, ...]
    error: str | None


def _expand_cache_path(raw: str) -> Path:
    """Expand a user-provided cache path like huggingface_hub.constants does."""
    return Path(os.path.expandvars(os.path.expanduser(raw)))  # noqa: PTH111


def _default_home() -> Path:
    """Return the user cache root used when HF_HOME and XDG_CACHE_HOME are unset."""
    return Path.home() / ".cache"


def resolve_cache_environment(
    environ: Mapping[str, str] | None = None,
    overrides: CachePathOverrides | None = None,
) -> CacheEnvironment:
    """Resolve effective cache directories honoring settings overrides.

    Resolution mirrors the precedence rules of huggingface_hub.constants so the
    reported paths are the same the pinned library would use at runtime. The
    legacy HUGGINGFACE_HUB_CACHE variable is honored as a fallback, and explicit
    settings overrides win over both environment and default values.

    Args:
        environ: Environment variable mapping; defaults to the process env.
        overrides: Optional user-selected cache destinations from settings.

    Returns:
        The effective HF_HOME, HF_HUB_CACHE, and HF_XET_CACHE directories.
    """
    env = os.environ if environ is None else environ
    if hf_home_raw := env.get(ENV_HF_HOME):
        hf_home = _expand_cache_path(hf_home_raw)
    else:
        xdg_root = env.get(ENV_XDG_CACHE_HOME)
        default_home = Path(xdg_root) if xdg_root else _default_home()
        hf_home = _expand_cache_path(str(default_home / "huggingface"))
    hub_default = str(hf_home / "hub")
    hub_raw = env.get(ENV_HF_HUB_CACHE, env.get(ENV_LEGACY_HUB_CACHE, hub_default))
    hub_cache = _expand_cache_path(hub_raw)
    xet_default = str(hf_home / "xet")
    xet_raw = env.get(ENV_HF_XET_CACHE, xet_default)
    xet_cache = _expand_cache_path(xet_raw)
    if overrides is not None:
        if overrides.hub_cache is not None:
            hub_cache = overrides.hub_cache
        if overrides.xet_cache is not None:
            xet_cache = overrides.xet_cache
    return CacheEnvironment(hf_home=hf_home, hub_cache=hub_cache, xet_cache=xet_cache)


def scan_hub_cache(cache_dir: Path) -> HubCacheScan:
    """Scan one Hub cache directory through the pinned adapter, never raising.

    The adapter imports the official scan_cache_dir API from the version pinned
    in the project manifest. Inaccessible directories and corrupted cached repos
    are returned as typed partial results instead of exceptions; cache pruning
    and deletion are deliberately out of scope.

    Args:
        cache_dir: The effective HF_HUB_CACHE directory to inspect.

    Returns:
        A typed scan result that is absent, partially scanned, or complete.
    """
    installed_version = huggingface_hub.__version__
    if installed_version != PINNED_HF_HUB_VERSION:
        return HubCacheScan(
            cache_dir=cache_dir,
            exists=False,
            scanned=False,
            size_on_disk=None,
            repo_count=0,
            incomplete_files=0,
            corrupt_entries=(),
            error=(
                f"unsupported huggingface_hub {installed_version}; "
                f"pinned adapter requires {PINNED_HF_HUB_VERSION}"
            ),
        )
    try:
        info = scan_cache_dir(cache_dir)
    except CacheNotFound:
        return HubCacheScan(
            cache_dir=cache_dir,
            exists=False,
            scanned=False,
            size_on_disk=None,
            repo_count=0,
            incomplete_files=0,
            corrupt_entries=(),
            error=None,
        )
    except (OSError, ValueError) as error:
        return HubCacheScan(
            cache_dir=cache_dir,
            exists=False,
            scanned=False,
            size_on_disk=None,
            repo_count=0,
            incomplete_files=0,
            corrupt_entries=(),
            error=str(error),
        )
    return HubCacheScan(
        cache_dir=cache_dir,
        exists=True,
        scanned=True,
        size_on_disk=info.size_on_disk,
        repo_count=len(info.repos),
        incomplete_files=len(info.incomplete_files),
        corrupt_entries=tuple(str(warning) for warning in info.warnings),
        error=None,
    )
