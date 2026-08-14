"""Tests for the strict per-task proxy policy boundary."""

from __future__ import annotations

import pytest

from hubfetch.domain.task_spec import ProxyMode
from hubfetch.network.proxy import (
    DEFAULT_NO_PROXY_VALUE,
    DirectProxy,
    ManualProxy,
    ProxyPolicyError,
    SystemProxy,
    apply_proxy_policy,
    build_proxy_policy,
)

MANUAL_SEED: str = "http://127.0.0.1:7897"

PROXY_PARENT: dict[str, str] = {
    "ALL_PROXY": "http://inherited:8080",
    "HTTP_PROXY": "http://inherited:8080",
    "HTTPS_PROXY": "http://inherited:8080",
    "NO_PROXY": "localhost",
    "PATH": "C:\\Windows",
    "all_proxy": "http://inherited:8080",
    "http_proxy": "http://inherited:8080",
    "https_proxy": "http://inherited:8080",
    "no_proxy": "localhost",
}

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


def test_manual_parse_accepts_the_seeded_local_proxy() -> None:
    """Given the seeded URL, parsing yields host, port, and a normalized URL."""
    manual = ManualProxy.parse(MANUAL_SEED)

    assert manual.scheme == "http"
    assert manual.host == "127.0.0.1"
    assert manual.port == 7897
    assert manual.url == MANUAL_SEED


def test_manual_parse_accepts_https_without_an_explicit_port() -> None:
    """Given an https URL without a port, parsing keeps the port unset."""
    manual = ManualProxy.parse("https://proxy.example")

    assert manual.scheme == "https"
    assert manual.host == "proxy.example"
    assert manual.port is None
    assert manual.url == "https://proxy.example"


def test_manual_parse_accepts_an_ipv6_host() -> None:
    """Given an IPv6 proxy host, parsing preserves the bracketed URL form."""
    manual = ManualProxy.parse("http://[::1]:7897")

    assert manual.host == "::1"
    assert manual.port == 7897
    assert manual.url == "http://[::1]:7897"


def test_manual_parse_normalizes_an_uppercase_scheme() -> None:
    """Given an uppercase scheme, parsing emits the canonical lowercase form."""
    manual = ManualProxy.parse("HTTP://proxy.example:8080")

    assert manual.scheme == "http"
    assert manual.url == "http://proxy.example:8080"


@pytest.mark.parametrize(
    "url",
    [
        "http://user:pass@proxy.example:8080",
        "http://user@proxy.example:8080",
        "file:///C:/proxy",
        "socks5://proxy.example:1080",
        "ftp://proxy.example",
        "http://proxy.example:8080#frag",
        "http://proxy.example:8080?q=1",
        "http://proxy.example:8080/path",
        "http://proxy.example:8080/",
        "http://proxy.example:99999",
        "http://proxy.example:abc",
        "http://proxy.example:",
        "http://",
        "",
        "   http://proxy.example:8080   ",
        "not a url",
    ],
)
def test_manual_parse_rejects_invalid_proxy_urls(url: str) -> None:
    """Given an invalid proxy URL, parsing raises a typed boundary error."""
    with pytest.raises(ProxyPolicyError) as caught:
        _ = ManualProxy.parse(url)

    assert caught.value.reason


def test_system_policy_requires_no_manual_url() -> None:
    """Given system mode, the policy is the system variant."""
    policy = build_proxy_policy(ProxyMode.SYSTEM)

    assert isinstance(policy, SystemProxy)


def test_system_policy_rejects_a_manual_url() -> None:
    """Given a manual URL with system mode, building raises a typed error."""
    with pytest.raises(ProxyPolicyError):
        _ = build_proxy_policy(ProxyMode.SYSTEM, manual_url=MANUAL_SEED)


def test_direct_policy_requires_no_manual_url() -> None:
    """Given direct mode, the policy is the direct variant."""
    policy = build_proxy_policy(ProxyMode.DIRECT)

    assert isinstance(policy, DirectProxy)


def test_direct_policy_rejects_a_manual_url() -> None:
    """Given a manual URL with direct mode, building raises a typed error."""
    with pytest.raises(ProxyPolicyError):
        _ = build_proxy_policy(ProxyMode.DIRECT, manual_url=MANUAL_SEED)


def test_manual_policy_parses_the_provided_url() -> None:
    """Given manual mode with a URL, building yields a validated manual proxy."""
    policy = build_proxy_policy(ProxyMode.MANUAL, manual_url=MANUAL_SEED)

    assert isinstance(policy, ManualProxy)
    assert policy.url == MANUAL_SEED


def test_manual_policy_requires_a_proxy_url() -> None:
    """Given manual mode without a URL, building raises a typed error."""
    with pytest.raises(ProxyPolicyError):
        _ = build_proxy_policy(ProxyMode.MANUAL)


def test_system_mode_inherits_proxy_variables_unchanged() -> None:
    """Given a system policy, the environment copy keeps every proxy variable."""
    result = apply_proxy_policy(PROXY_PARENT, SystemProxy())

    assert result == PROXY_PARENT


def test_direct_mode_removes_every_upper_and_lowercase_proxy_variable() -> None:
    """Given a direct policy, no proxy variable survives in the copy."""
    result = apply_proxy_policy(PROXY_PARENT, DirectProxy())

    assert all(name not in result for name in PROXY_VARIABLE_NAMES)
    assert result["PATH"] == "C:\\Windows"


def test_manual_mode_replaces_proxy_variables_and_sets_no_proxy() -> None:
    """Given a manual policy, proxy variables are replaced consistently."""
    result = apply_proxy_policy(PROXY_PARENT, ManualProxy.parse(MANUAL_SEED))

    assert result["ALL_PROXY"] == MANUAL_SEED
    assert result["HTTP_PROXY"] == MANUAL_SEED
    assert result["HTTPS_PROXY"] == MANUAL_SEED
    assert result["NO_PROXY"] == DEFAULT_NO_PROXY_VALUE
    assert all(
        name not in result
        for name in ("all_proxy", "http_proxy", "https_proxy", "no_proxy")
    )
    assert result["PATH"] == "C:\\Windows"


def test_apply_proxy_policy_never_mutates_the_parent_mapping() -> None:
    """Given a parent mapping, applying a policy leaves the mapping untouched."""
    parent = dict(PROXY_PARENT)

    _ = apply_proxy_policy(parent, DirectProxy())

    assert parent == PROXY_PARENT
