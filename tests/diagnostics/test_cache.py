"""Tests for effective Hugging Face cache path resolution and scanning."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import huggingface_hub

import hubfetch.diagnostics.cache as cache_module
from hubfetch.config.settings import CachePathOverrides
from hubfetch.diagnostics.cache import (
    CacheEnvironment,
    HubCacheScan,
    resolve_cache_environment,
    scan_hub_cache,
)

if TYPE_CHECKING:
    import pytest


def _build_valid_cache(root: Path) -> None:
    """Create one valid cached model with a matching ref and two files."""
    repo = root / "models--org--model"
    snapshot = repo / "snapshots" / "deadbeef"
    snapshot.mkdir(parents=True)
    _ = (snapshot / "config.json").write_text('{"ok": true}', encoding="utf-8")
    _ = (snapshot / "weights.bin").write_bytes(b"x" * 1024)
    refs = repo / "refs"
    refs.mkdir(parents=True)
    _ = (refs / "main").write_text("deadbeef", encoding="utf-8")


def _build_corrupt_cache(root: Path) -> None:
    """Create a repo with a ref but no snapshots directory."""
    repo = root / "models--org--broken"
    refs = repo / "refs"
    refs.mkdir(parents=True)
    _ = (refs / "main").write_text("cafebabe", encoding="utf-8")


def test_default_environment_resolves_under_user_cache() -> None:
    """Given no cache variables, resolution uses the default user cache."""
    environment = resolve_cache_environment(environ={})

    expected_home = Path.home() / ".cache" / "huggingface"
    assert environment == CacheEnvironment(
        hf_home=expected_home,
        hub_cache=expected_home / "hub",
        xet_cache=expected_home / "xet",
    )


def test_hf_home_environment_rebases_all_defaults(tmp_path: Path) -> None:
    """Given HF_HOME, hub and xet caches derive from it by default."""
    environment = resolve_cache_environment(environ={"HF_HOME": str(tmp_path / "home")})

    assert environment.hf_home == tmp_path / "home"
    assert environment.hub_cache == tmp_path / "home" / "hub"
    assert environment.xet_cache == tmp_path / "home" / "xet"


def test_hf_hub_cache_environment_overrides_default(tmp_path: Path) -> None:
    """Given HF_HUB_CACHE, the hub cache path is honored."""
    environment = resolve_cache_environment(
        environ={
            "HF_HOME": str(tmp_path / "home"),
            "HF_HUB_CACHE": str(tmp_path / "elsewhere" / "hub"),
        }
    )

    assert environment.hub_cache == tmp_path / "elsewhere" / "hub"
    assert environment.xet_cache == tmp_path / "home" / "xet"


def test_hf_xet_cache_environment_overrides_default(tmp_path: Path) -> None:
    """Given HF_XET_CACHE, the Xet cache path is honored."""
    environment = resolve_cache_environment(
        environ={
            "HF_HOME": str(tmp_path / "home"),
            "HF_XET_CACHE": str(tmp_path / "elsewhere" / "xet"),
        }
    )

    assert environment.hub_cache == tmp_path / "home" / "hub"
    assert environment.xet_cache == tmp_path / "elsewhere" / "xet"


def test_legacy_huggingface_hub_cache_environment_is_honored(tmp_path: Path) -> None:
    """Given the legacy HUGGINGFACE_HUB_CACHE, it falls back for the hub cache."""
    environment = resolve_cache_environment(
        environ={
            "HF_HOME": str(tmp_path / "home"),
            "HUGGINGFACE_HUB_CACHE": str(tmp_path / "legacy" / "hub"),
        }
    )

    assert environment.hub_cache == tmp_path / "legacy" / "hub"


def test_xdg_cache_home_fallback_when_hf_home_is_unset(tmp_path: Path) -> None:
    """Given XDG_CACHE_HOME and no HF_HOME, the huggingface dir sits under it."""
    environment = resolve_cache_environment(
        environ={"XDG_CACHE_HOME": str(tmp_path / "xdg")}
    )

    assert environment.hf_home == tmp_path / "xdg" / "huggingface"


def test_settings_overrides_beat_environment_and_defaults(tmp_path: Path) -> None:
    """Given settings overrides, they win over environment and defaults."""
    environment = resolve_cache_environment(
        environ={
            "HF_HOME": str(tmp_path / "home"),
            "HF_HUB_CACHE": str(tmp_path / "env" / "hub"),
        },
        overrides=CachePathOverrides(
            hub_cache=tmp_path / "settings" / "hub",
            xet_cache=tmp_path / "settings" / "xet",
        ),
    )

    assert environment.hub_cache == tmp_path / "settings" / "hub"
    assert environment.xet_cache == tmp_path / "settings" / "xet"


def test_scan_missing_cache_dir_is_reported_as_absent(tmp_path: Path) -> None:
    """Given a missing cache directory, the scan is absent without an error."""
    scan = scan_hub_cache(tmp_path / "missing")

    assert scan == HubCacheScan(
        cache_dir=tmp_path / "missing",
        exists=False,
        scanned=False,
        size_on_disk=None,
        repo_count=0,
        incomplete_files=0,
        corrupt_entries=(),
        error=None,
    )


def test_scan_valid_cache_reports_size_and_repo_count(tmp_path: Path) -> None:
    """Given a valid cached model, the scan reports bytes and one repo."""
    _build_valid_cache(tmp_path)

    scan = scan_hub_cache(tmp_path)

    assert scan.exists is True
    assert scan.scanned is True
    assert scan.repo_count == 1
    assert scan.size_on_disk == len('{"ok": true}') + 1024
    assert scan.corrupt_entries == ()


def test_scan_corrupt_cache_is_a_typed_partial_result(tmp_path: Path) -> None:
    """Given a repo without snapshots, corruption is captured not raised."""
    _build_corrupt_cache(tmp_path)

    scan = scan_hub_cache(tmp_path)

    assert scan.exists is True
    assert scan.scanned is True
    assert len(scan.corrupt_entries) == 1
    assert "Snapshots dir doesn't exist" in scan.corrupt_entries[0]


def test_scan_file_path_is_a_typed_partial_result(tmp_path: Path) -> None:
    """Given a file where a cache dir is expected, the scan reports an error."""
    cache_file = tmp_path / "cache"
    _ = cache_file.write_text("not a directory", encoding="utf-8")

    scan = scan_hub_cache(cache_file)

    assert scan.exists is False
    assert scan.scanned is False
    assert scan.error is not None


def test_scan_os_error_is_a_typed_partial_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Given a scanner OSError, the adapter returns a typed partial result."""

    def deny(_cache_dir: Path) -> object:
        message = "access denied"
        raise PermissionError(message)

    monkeypatch.setattr(cache_module, "scan_cache_dir", deny)

    scan = scan_hub_cache(tmp_path)

    assert scan.scanned is False
    assert scan.error == "access denied"


def test_scan_unpinned_hub_version_is_a_typed_partial_result(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Given an unpinned huggingface_hub, the adapter disables with a reason."""
    monkeypatch.setattr(huggingface_hub, "__version__", "9.9.9")

    scan = scan_hub_cache(tmp_path)

    assert scan.scanned is False
    assert scan.error is not None
    assert "9.9.9" in (scan.error or "")
