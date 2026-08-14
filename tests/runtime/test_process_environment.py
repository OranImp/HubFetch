"""Tests for fresh per-worker QProcessEnvironment isolation."""

from __future__ import annotations

from typing import Final

from PySide6.QtCore import QProcessEnvironment

from hubfetch.domain.task_spec import ProxyMode
from hubfetch.network.proxy import (
    DEFAULT_NO_PROXY_VALUE,
    ProxyPolicy,
    build_proxy_policy,
)
from hubfetch.runtime.process_environment import (
    environment_mapping,
    git_worker_environment,
    hub_worker_environment,
)

HF_TEST_SECRET: Final = "hf_test_secret_123"  # noqa: S105
MANUAL_SEED: Final = "http://127.0.0.1:7897"

PROXY_VARIABLE_NAMES: tuple[str, ...] = (
    "ALL_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "all_proxy",
    "http_proxy",
    "https_proxy",
    "no_proxy",
)

SECRET_AND_AUTH_NAMES: tuple[str, ...] = (
    "GIT_ASKPASS",
    "HF_TOKEN",
    "HF_TOKEN_PATH",
    "HUGGING_FACE_HUB_TOKEN",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "hf_token",
)


def _parent() -> dict[str, str]:
    """Return a realistic parent environment carrying secrets and proxy vars."""
    return {
        "ALL_PROXY": "http://inherited:8080",
        "HTTP_PROXY": "http://inherited:8080",
        "HTTPS_PROXY": "http://inherited:8080",
        "NO_PROXY": "localhost",
        "PATH": "C:\\Windows",
        "SystemRoot": "C:\\Windows",
        "all_proxy": "http://inherited:8080",
        "http_proxy": "http://inherited:8080",
        "https_proxy": "http://inherited:8080",
        "no_proxy": "localhost",
        "HF_TOKEN": HF_TEST_SECRET,
        "hf_token": "case-variant-token",
        "HUGGING_FACE_HUB_TOKEN": "legacy-token",
        "HF_TOKEN_PATH": "C:\\shared\\token",
        "GIT_ASKPASS": "C:\\askpass.exe",
        "SSH_ASKPASS": "C:\\askpass.exe",
        "SSH_ASKPASS_REQUIRE": "force",
        "HUBFETCH_APP_DATA_ROOT": "C:\\app-data",
        "HUBFETCH_SENTINEL": "must-not-leak",
    }


def _manual_policy() -> ProxyPolicy:
    return build_proxy_policy(ProxyMode.MANUAL, manual_url=MANUAL_SEED)


def test_build_returns_a_fresh_qprocessenvironment() -> None:
    """Given a parent and a system policy, the builder returns a QProcessEnvironment."""
    environment = hub_worker_environment(
        _parent(), build_proxy_policy(ProxyMode.SYSTEM)
    )

    assert isinstance(environment, QProcessEnvironment)
    assert not environment.isEmpty()


def test_token_and_askpass_variables_are_stripped_in_every_mode() -> None:
    """Given any mode, secret and auth variables never reach the child mapping."""
    policies = (
        build_proxy_policy(ProxyMode.SYSTEM),
        build_proxy_policy(ProxyMode.DIRECT),
        _manual_policy(),
    )
    for policy in policies:
        values = environment_mapping(hub_worker_environment(_parent(), policy))
        assert all(name not in values for name in SECRET_AND_AUTH_NAMES)


def test_app_sentinel_variables_are_stripped_in_every_mode() -> None:
    """Given any mode, app-reserved variables never reach the child mapping."""
    policies = (
        build_proxy_policy(ProxyMode.SYSTEM),
        build_proxy_policy(ProxyMode.DIRECT),
        _manual_policy(),
    )
    for policy in policies:
        values = environment_mapping(hub_worker_environment(_parent(), policy))
        assert "HUBFETCH_APP_DATA_ROOT" not in values
        assert "HUBFETCH_SENTINEL" not in values


def test_sentinel_secret_bytes_never_reach_the_child_environment() -> None:
    """Given an inherited HF_TOKEN sentinel, its bytes are absent from the child."""
    for policy in (
        build_proxy_policy(ProxyMode.SYSTEM),
        build_proxy_policy(ProxyMode.DIRECT),
        _manual_policy(),
    ):
        values = environment_mapping(hub_worker_environment(_parent(), policy))
        joined = "".join(f"{name}={value}" for name, value in values.items())
        assert HF_TEST_SECRET not in joined
        assert "case-variant-token" not in joined
        assert "legacy-token" not in joined


def test_system_mode_inherits_proxy_variables() -> None:
    """Given a system policy, inherited proxy variables survive in the child."""
    values = environment_mapping(
        hub_worker_environment(_parent(), build_proxy_policy(ProxyMode.SYSTEM))
    )

    assert values["HTTP_PROXY"] == "http://inherited:8080"
    assert values["NO_PROXY"] == "localhost"


def test_direct_mode_clears_proxy_variables_in_the_worker_only() -> None:
    """Given a direct policy, the child has no proxy variable while PATH survives."""
    values = environment_mapping(
        hub_worker_environment(_parent(), build_proxy_policy(ProxyMode.DIRECT))
    )

    assert all(name not in values for name in PROXY_VARIABLE_NAMES)
    assert values["PATH"] == "C:\\Windows"


def test_manual_mode_replaces_proxy_variables_consistently() -> None:
    """Given a manual policy, the child carries the validated proxy URL and NO_PROXY."""
    values = environment_mapping(hub_worker_environment(_parent(), _manual_policy()))

    assert values["ALL_PROXY"] == MANUAL_SEED
    assert values["HTTP_PROXY"] == MANUAL_SEED
    assert values["HTTPS_PROXY"] == MANUAL_SEED
    assert values["NO_PROXY"] == DEFAULT_NO_PROXY_VALUE
    assert all(
        name not in values
        for name in ("all_proxy", "http_proxy", "https_proxy", "no_proxy")
    )
    assert values["PATH"] == "C:\\Windows"


def test_hub_and_git_workers_share_the_same_typed_policy() -> None:
    """Given the same parent and policy, Hub and Git worker environments match."""
    parent = _parent()
    policy = _manual_policy()

    hub = hub_worker_environment(parent, policy)
    git = git_worker_environment(parent, policy)

    assert sorted(hub.toStringList()) == sorted(git.toStringList())


def test_building_environments_never_mutates_the_parent_mapping() -> None:
    """Given a parent mapping, building every mode leaves the mapping untouched."""
    parent = _parent()
    before = dict(parent)

    _ = hub_worker_environment(parent, build_proxy_policy(ProxyMode.SYSTEM))
    _ = hub_worker_environment(parent, build_proxy_policy(ProxyMode.DIRECT))
    _ = hub_worker_environment(parent, _manual_policy())

    assert parent == before


def test_environment_mapping_round_trips_qprocessenvironment() -> None:
    """Given a QProcessEnvironment, the mapping helper returns its key-value pairs."""
    environment = QProcessEnvironment()
    environment.insert("A", "1")
    environment.insert("B", "2")

    assert environment_mapping(environment) == {"A": "1", "B": "2"}
