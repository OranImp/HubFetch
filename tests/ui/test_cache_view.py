# noqa: SIZE_OK - one module must enumerate the whole cache-surface contract:
# read-only commands, refresh readout, folder opening seams, probe cleanup, and
# missing-cache handling.

"""Given/When/Then contracts for the read-only Cache work surface.

Todo 27's Cache surface inspects the effective HF_HOME/HF_HUB_CACHE/HF_XET_CACHE
paths, hub-cache size and integrity, symlink capability, and volume free space.
Open Folder and Refresh are the only commands; pruning and deletion are out of
scope and must never appear.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from hubfetch.config.settings import CachePathOverrides, Locale, Settings
from hubfetch.ui.cache.view import CacheView, CacheViewTexts
from hubfetch.ui.widgets.buttons import ActionButton

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from pytestqt.qtbot import QtBot


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


def _make_view(
    qtbot: QtBot,
    *,
    environ: dict[str, str] | None = None,
    settings: Settings | None = None,
    opener: Callable[[Path], bool] | None = None,
) -> CacheView:
    """Build a cache view with overridable environment and folder seam."""
    view = CacheView(
        CacheViewTexts.for_locale(Locale.ZH_CN),
        settings=settings if settings is not None else Settings(),
        environ=environ,
        opener=opener,
    )
    qtbot.addWidget(view)
    return view


def test_view_exposes_only_open_folder_and_refresh_commands(
    qtbot: QtBot,
) -> None:
    """Given an empty cache view, When inspecting its commands, Then only the
    two read-only actions exist and no prune/delete command is present."""
    view = _make_view(qtbot)
    buttons = view.findChildren(ActionButton)
    assert set(buttons) == {view.open_folder_button(), view.refresh_button()}
    spoken = [button.text() for button in buttons]
    combined = " ".join(spoken)
    assert "Prune" not in combined
    assert "Delete" not in combined
    assert "清理" not in combined
    assert "删除" not in combined


def test_refresh_populates_typed_readout(qtbot: QtBot, tmp_path: Path) -> None:
    """Given a populated hub cache, When refreshing, Then the readout reports
    effective paths, scan results, size, and volume free space."""
    root = tmp_path / "hf"
    _build_valid_cache(root / "hub")
    view = _make_view(qtbot, environ={"HF_HOME": str(root)})

    readout = view.refresh()

    assert readout is not None
    assert readout.environment.hub_cache == root / "hub"
    assert readout.environment.xet_cache == root / "xet"
    scan = readout.hub_scan
    assert scan.scanned is True
    assert scan.repo_count == 1
    assert scan.size_on_disk is not None
    assert scan.size_on_disk > 0
    assert readout.hub_size is not None
    assert readout.hub_size.bytes_total is not None
    assert readout.hub_size.bytes_total > 0
    assert readout.hub_size.complete is True
    assert readout.volume.free_bytes is not None
    assert readout.hub_probe is not None


def test_open_folder_invokes_opener_with_hub_cache_path(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given a populated cache, When Open Folder fires, Then the injected opener
    receives the effective hub cache path and the result is surfaced."""
    opened: list[Path] = []
    root = tmp_path / "hf"
    _build_valid_cache(root / "hub")
    view = _make_view(
        qtbot,
        environ={"HF_HOME": str(root)},
        opener=lambda path: opened.append(path) or True,
    )
    _ = view.refresh()

    result = view.open_folder()

    assert result is True
    assert opened == [root / "hub"]


def test_open_folder_refused_when_cache_directory_missing(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given an effective hub cache that does not exist, When Open Folder fires,
    Then the opener is never called and the command reports failure."""
    opened: list[Path] = []
    root = tmp_path / "missing"
    view = _make_view(
        qtbot,
        environ={"HF_HOME": str(root)},
        opener=lambda path: opened.append(path) or True,
    )
    _ = view.refresh()

    result = view.open_folder()

    assert result is False
    assert opened == []


def test_settings_cache_overrides_win_over_environment(
    qtbot: QtBot, tmp_path: Path
) -> None:
    """Given settings cache overrides, When refreshing, Then the overridden paths
    are the ones reported by the readout."""
    root = tmp_path / "hf"
    _build_valid_cache(tmp_path / "override-hub")
    settings = Settings(
        cache_path_overrides=CachePathOverrides(
            hub_cache=tmp_path / "override-hub",
            xet_cache=tmp_path / "override-xet",
        )
    )
    view = _make_view(
        qtbot,
        environ={"HF_HOME": str(root)},
        settings=settings,
    )

    readout = view.refresh()

    assert readout is not None
    assert readout.environment.hub_cache == tmp_path / "override-hub"
    assert readout.environment.xet_cache == tmp_path / "override-xet"


def test_refresh_cleans_every_probe_directory(qtbot: QtBot, tmp_path: Path) -> None:
    """Given a hub cache on a writable volume, When refreshing, Then no probe
    directory remains after the inspection completes."""
    root = tmp_path / "hf"
    _build_valid_cache(root / "hub")
    view = _make_view(qtbot, environ={"HF_HOME": str(root)})

    _ = view.refresh()

    remaining = [
        path
        for path in tmp_path.rglob("*")
        if path.is_dir() and path.name.startswith(".hubfetch-probe-")
    ]
    assert remaining == []


def test_refresh_button_recomputes_readout(qtbot: QtBot, tmp_path: Path) -> None:
    """Given two refreshes, When new cache data appears, Then the button-driven
    refresh reflects the later state."""
    root = tmp_path / "hf"
    _build_valid_cache(root / "hub")
    view = _make_view(qtbot, environ={"HF_HOME": str(root)})
    _ = view.refresh()
    first = view.readout()
    assert first is not None
    assert first.hub_scan.repo_count == 1

    extra = root / "hub" / "datasets--org--data"
    (extra / "snapshots" / "cafebabe").mkdir(parents=True)
    _ = (extra / "snapshots" / "cafebabe" / "file.bin").write_bytes(b"y" * 512)
    (extra / "refs").mkdir(parents=True)
    _ = (extra / "refs" / "main").write_text("cafebabe", encoding="utf-8")

    view.refresh_button().click()
    second = view.readout()
    assert second is not None
    assert second.hub_scan.repo_count == 2
