"""Tests for Qt-backed application paths and bootstrap directory creation."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from hubfetch.config.identity import AppIdentity
from hubfetch.config.paths import (
    HUBFETCH_APP_DATA_ROOT_ENV,
    AppPaths,
    resolve_app_paths,
)


@pytest.mark.windows
def test_app_paths_use_qstandardpaths_for_the_default_root() -> None:
    """Given Windows Qt standard paths, the app root is absolute and app-scoped."""
    paths = resolve_app_paths()

    assert paths.data_root.is_absolute()
    assert paths.database_path.name == AppIdentity().database_filename
    assert paths.log_root.is_absolute()
    assert paths.credentials_root.parent == paths.data_root


def test_app_paths_honor_only_the_documented_override_in_a_subprocess(
    tmp_path: Path,
) -> None:
    """Given a unique override, a fresh process resolves all paths beneath it."""
    override = tmp_path / "portable-root"
    environment = os.environ.copy()
    environment[HUBFETCH_APP_DATA_ROOT_ENV] = str(override)
    command = (
        "from hubfetch.config.paths import resolve_app_paths; "
        "import json; "
        "print(json.dumps(resolve_app_paths().as_json(), sort_keys=True))"
    )

    result = subprocess.run(  # noqa: S603 - fixed command list, no shell involved
        [sys.executable, "-c", command],
        capture_output=True,
        check=True,
        env=environment,
        text=True,
    )

    expected = {
        "cache_root": str(override / "cache"),
        "credentials_root": str(override / "credentials"),
        "data_root": str(override),
        "database_path": str(override / "hubfetch.db"),
        "log_root": str(override / "logs"),
    }
    assert result.stdout.strip() == json.dumps(expected, sort_keys=True)


def test_bootstrap_paths_creates_the_application_directories(tmp_path: Path) -> None:
    """Given an override root, bootstrapping creates every required directory."""
    override = tmp_path / "bootstrap-root"
    environment = os.environ.copy()
    environment[HUBFETCH_APP_DATA_ROOT_ENV] = str(override)

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from hubfetch.config.bootstrap import bootstrap_paths; bootstrap_paths()",
        ],
        capture_output=True,
        check=True,
        env=environment,
        text=True,
    )

    assert result.stdout == ""
    assert (override / "logs").is_dir()
    assert (override / "cache").is_dir()
    assert (override / "credentials").is_dir()


def test_app_paths_result_is_frozen() -> None:
    """Given resolved paths, replacing a path field is rejected."""
    paths = AppPaths(
        data_root=Path("data"),
        log_root=Path("logs"),
        cache_root=Path("cache"),
        credentials_root=Path("credentials"),
        database_path=Path("hubfetch.db"),
    )
    field_name = "data_root"

    with pytest.raises(FrozenInstanceError):
        setattr(paths, field_name, Path("other"))
