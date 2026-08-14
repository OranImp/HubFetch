"""Strict per-task proxy policy with validated manual HTTP(S) proxy URLs.

The policy is a closed triple -- system inheritance, an explicit direct mode
that clears every proxy variable in the worker only, and a validated manual
HTTP(S) proxy. One function applies the policy to an environment copy, so Hub
and Git workers always observe the same typed policy through the parity helper
in :mod:`hubfetch.runtime.process_environment`. The GUI/global environment is
never mutated: this module only reads and returns new mappings.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Literal, override
from urllib.parse import urlsplit

from hubfetch.domain.task_spec import ProxyMode

if TYPE_CHECKING:
    from collections.abc import Mapping

DEFAULT_NO_PROXY_VALUE: Final = "127.0.0.1,localhost"
"""Explicit no-proxy list set in manual mode so local traffic bypasses the proxy."""

PROXY_VARIABLES: Final[tuple[str, ...]] = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
)
"""Every uppercase and lowercase proxy variable the policy may remove or set."""


@dataclass(frozen=True, slots=True)
class ProxyPolicyError(ValueError):
    """A proxy policy value failed the strict boundary contract."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"invalid proxy policy: {self.reason}"


@dataclass(frozen=True, slots=True)
class SystemProxy:
    """Inherit the machine/system proxy settings unchanged."""


@dataclass(frozen=True, slots=True)
class DirectProxy:
    """Clear every proxy variable in the worker environment only."""


@dataclass(frozen=True, slots=True)
class ManualProxy:
    """A validated manual HTTP(S) proxy address with an optional port.

    Constructed only through :meth:`parse`, which enforces the boundary
    contract: http/https scheme, a host, an optional valid port, and no
    userinfo, path, query, or fragment.
    """

    scheme: Literal["http", "https"]
    host: str
    port: int | None

    @property
    def url(self) -> str:
        """Return the normalized proxy URL written into worker environments."""
        displayed_host = f"[{self.host}]" if ":" in self.host else self.host
        if self.port is None:
            return f"{self.scheme}://{displayed_host}"
        return f"{self.scheme}://{displayed_host}:{self.port}"

    @classmethod
    def parse(cls, value: str) -> ManualProxy:
        """Parse and validate one manual proxy URL at the environment boundary.

        Raises :class:`ProxyPolicyError` without echoing the rejected value for
        unsupported schemes, missing hosts, malformed ports, embedded
        credentials, or stray path/query/fragment components.
        """
        if not value or value != value.strip():
            raise ProxyPolicyError(
                reason="proxy URL must not be empty or have surrounding whitespace"
            )
        parsed = urlsplit(value)
        match parsed.scheme:
            case "http" | "https":
                scheme: Literal["http", "https"] = parsed.scheme
            case _:
                raise ProxyPolicyError(reason="proxy URL scheme must be http or https")
        try:
            port = parsed.port
        except ValueError as error:
            raise ProxyPolicyError(reason="proxy URL has a malformed port") from error
        if parsed.netloc.endswith(":"):
            raise ProxyPolicyError(reason="proxy URL has a malformed port")
        host = parsed.hostname
        if not host:
            raise ProxyPolicyError(reason="proxy URL requires a host")
        if parsed.username is not None or parsed.password is not None:
            raise ProxyPolicyError(reason="proxy URL must not embed credentials")
        if parsed.path or parsed.query or parsed.fragment:
            raise ProxyPolicyError(
                reason="proxy URL must not carry a path, query, or fragment"
            )
        return cls(scheme=scheme, host=host, port=port)


ProxyPolicy = SystemProxy | DirectProxy | ManualProxy
"""A closed per-task proxy policy shared by Hub and Git workers."""


def build_proxy_policy(mode: ProxyMode, manual_url: str | None = None) -> ProxyPolicy:
    """Build a validated policy from a task proxy mode and optional manual URL.

    System and direct modes reject a manual URL; manual mode requires one.
    """
    match mode:
        case ProxyMode.SYSTEM:
            if manual_url is not None:
                raise ProxyPolicyError(reason="system mode rejects a manual proxy URL")
            return SystemProxy()
        case ProxyMode.DIRECT:
            if manual_url is not None:
                raise ProxyPolicyError(reason="direct mode rejects a manual proxy URL")
            return DirectProxy()
        case ProxyMode.MANUAL:
            if manual_url is None:
                raise ProxyPolicyError(reason="manual mode requires a proxy URL")
            return ManualProxy.parse(manual_url)


def apply_proxy_policy(
    environment: Mapping[str, str], policy: ProxyPolicy
) -> dict[str, str]:
    """Return a copy of ``environment`` with proxy variables rewritten.

    The input mapping is never mutated. System mode preserves the variables;
    direct mode removes every uppercase and lowercase proxy variable; manual
    mode removes them all and then sets a consistent HTTP(S)/ALL proxy plus an
    explicit ``NO_PROXY`` policy.
    """
    result = dict(environment)
    match policy:
        case SystemProxy():
            return result
        case DirectProxy():
            for name in PROXY_VARIABLES:
                _ = result.pop(name, None)
            return result
        case ManualProxy() as manual:
            for name in PROXY_VARIABLES:
                _ = result.pop(name, None)
            result["HTTP_PROXY"] = manual.url
            result["HTTPS_PROXY"] = manual.url
            result["ALL_PROXY"] = manual.url
            result["NO_PROXY"] = DEFAULT_NO_PROXY_VALUE
            return result
