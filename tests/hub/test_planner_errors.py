"""Auth-mode and Hub-error mapping wire tests for the planner.

Given/When/Then throughout. These tests drive the real adapter against the
deterministic Hub fixture to prove every auth source resolves to the right
token on the wire and every Hub failure returns its distinct Todo 6 recovery
descriptor, including TLS and proxy network failures with no external
network.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

import pytest

from hubfetch.credentials.models import CredentialAlias
from hubfetch.domain.errors import ErrorCategory, HubFetchError, RecoveryAction
from hubfetch.domain.task_spec import AuthSource, ProxyMode
from hubfetch.hub.adapter import HubAdapter
from hubfetch.hub.planner import DownloadPlanner

if TYPE_CHECKING:
    from pathlib import Path

from .fixtures import hub_fixture
from .helpers import (
    FILES,
    MANUAL_TOKEN,
    SHARED_TOKEN,
    InMemoryCredentialStore,
    make_adapter,
    make_file_spec,
    make_repository,
)


class TestAuthModes:
    """Given an auth source, when planning, then the right token reaches the wire."""

    def test_anonymous_sends_no_token(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, forbid_token=True) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.total_bytes == 554

    def test_shared_oauth_sends_machine_shared_token(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("HF_TOKEN", SHARED_TOKEN)
        with hub_fixture(files=FILES, expect_token=SHARED_TOKEN) as fixture:
            planner = DownloadPlanner(
                make_adapter(
                    fixture,
                    auth=AuthSource.SHARED_OAUTH,
                    cache_dir=tmp_path / "cache",
                )
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.total_bytes == 554

    def test_manual_token_resolves_through_store(self, tmp_path: Path) -> None:
        store = InMemoryCredentialStore()
        alias = store.create(token=MANUAL_TOKEN)
        with hub_fixture(files=FILES, expect_token=MANUAL_TOKEN) as fixture:
            planner = DownloadPlanner(
                make_adapter(
                    fixture,
                    auth=AuthSource.MANUAL_TOKEN,
                    store=store,
                    alias=alias,
                    cache_dir=tmp_path / "cache",
                )
            )
            plan = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert plan.total_bytes == 554

    def test_manual_token_missing_alias_maps_to_authentication(
        self, tmp_path: Path
    ) -> None:
        store = InMemoryCredentialStore()
        missing = CredentialAlias("hfc-000000000000000000000000000000ff")
        with (
            hub_fixture(files=FILES) as fixture,
            pytest.raises(HubFetchError) as caught,
        ):
            _ = make_adapter(
                fixture,
                auth=AuthSource.MANUAL_TOKEN,
                store=store,
                alias=missing,
                cache_dir=tmp_path / "cache",
            )
        assert caught.value.spec.category is ErrorCategory.AUTHENTICATION
        assert caught.value.recovery_action is RecoveryAction.REAUTHENTICATE

    def test_manual_token_without_store_is_rejected(self, tmp_path: Path) -> None:
        with (
            hub_fixture(files=FILES) as fixture,
            pytest.raises(HubFetchError) as caught,
        ):
            _ = make_adapter(
                fixture,
                auth=AuthSource.MANUAL_TOKEN,
                cache_dir=tmp_path / "cache",
            )
        assert caught.value.spec.category is ErrorCategory.VALIDATION

    def test_invalid_proxy_policy_is_rejected(self, tmp_path: Path) -> None:
        with (
            hub_fixture(files=FILES) as fixture,
            pytest.raises(HubFetchError) as caught,
        ):
            _ = HubAdapter(
                auth_source=AuthSource.ANONYMOUS,
                proxy_mode=ProxyMode.MANUAL,
                manual_proxy_url="https://user:pass@127.0.0.1:9",
                endpoint=fixture.endpoint,
                cache_dir=tmp_path / "cache",
            )
        assert caught.value.spec.category is ErrorCategory.VALIDATION


class TestHubErrorMappingWire:
    """Given Hub failure fixtures, when planning, distinct descriptors return."""

    def test_repo_not_found_anonymous_maps_to_authentication(
        self, tmp_path: Path
    ) -> None:
        with hub_fixture(files=FILES, error="repo_not_found") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.AUTHENTICATION
        assert caught.value.recovery_action is RecoveryAction.REAUTHENTICATE

    def test_repo_not_found_with_token_maps_to_not_found(self, tmp_path: Path) -> None:
        store = InMemoryCredentialStore()
        alias = store.create(token=MANUAL_TOKEN)
        with hub_fixture(files=FILES, error="repo_not_found") as fixture:
            planner = DownloadPlanner(
                make_adapter(
                    fixture,
                    auth=AuthSource.MANUAL_TOKEN,
                    store=store,
                    alias=alias,
                    cache_dir=tmp_path / "cache",
                )
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.NOT_FOUND
        assert caught.value.recovery_action is RecoveryAction.CHECK_REVISION

    def test_gated_repo_maps_to_request_access(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, error="gated") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.GATED_ACCESS
        assert caught.value.recovery_action is RecoveryAction.REQUEST_ACCESS

    def test_revision_not_found_maps_to_not_found(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, error="revision_not_found") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.NOT_FOUND
        assert caught.value.recovery_action is RecoveryAction.CHECK_REVISION

    def test_unauthorized_maps_to_authentication(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, error="unauthorized") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.AUTHENTICATION

    def test_invalid_credentials_maps_to_authentication(self, tmp_path: Path) -> None:
        store = InMemoryCredentialStore()
        alias = store.create(token=MANUAL_TOKEN)
        with hub_fixture(
            files=FILES, error="invalid_credentials", expect_token=MANUAL_TOKEN
        ) as fixture:
            planner = DownloadPlanner(
                make_adapter(
                    fixture,
                    auth=AuthSource.MANUAL_TOKEN,
                    store=store,
                    alias=alias,
                    cache_dir=tmp_path / "cache",
                )
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.AUTHENTICATION
        assert caught.value.recovery_action is RecoveryAction.REAUTHENTICATE

    def test_rate_limit_maps_to_check_network(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, error="rate_limit") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.NETWORK
        assert caught.value.recovery_action is RecoveryAction.CHECK_NETWORK

    def test_server_error_maps_to_check_network(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES, error="server_error") as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.NETWORK

    def test_tls_failure_maps_to_check_network(self, tmp_path: Path) -> None:
        with hub_fixture(files=FILES) as fixture:
            adapter = make_adapter(
                fixture,
                cache_dir=tmp_path / "cache",
                endpoint=f"https://127.0.0.1:{fixture.port}",
            )
            planner = DownloadPlanner(adapter)
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.NETWORK
        assert caught.value.recovery_action is RecoveryAction.CHECK_NETWORK

    def test_proxy_failure_maps_to_check_network(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        http_module = importlib.import_module("huggingface_hub.utils._http")
        monkeypatch.setattr(http_module, "_GLOBAL_CLIENT", None)
        for name in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            monkeypatch.setenv(name, "http://127.0.0.1:1")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        with hub_fixture(files=FILES) as fixture:
            planner = DownloadPlanner(
                make_adapter(fixture, cache_dir=tmp_path / "cache")
            )
            with pytest.raises(HubFetchError) as caught:
                _ = planner.plan(make_file_spec(make_repository(), "config.json"))
        assert caught.value.spec.category is ErrorCategory.NETWORK
        assert caught.value.recovery_action is RecoveryAction.CHECK_NETWORK
