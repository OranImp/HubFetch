"""Structural and pattern redaction of HubFetch diagnostics before serialization."""

from __future__ import annotations

import re
from contextlib import contextmanager
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final, override
from urllib.parse import unquote, urlsplit, urlunsplit

from pydantic import BaseModel

if TYPE_CHECKING:
    from collections.abc import Generator, Iterator, Mapping

REDACTED: Final = "[REDACTED]"
"""Deterministic placeholder that replaces every removed secret."""

type JsonValue = (
    str | int | float | bool | list[JsonValue] | dict[str, JsonValue] | None
)
"""JSON-safe diagnostic values accepted and returned by the redactor."""

_SENSITIVE_HEADER_NAMES: Final = frozenset(
    {
        "authorization",
        "cookie",
        "proxy-authorization",
        "set-cookie",
        "x-amz-security-token",
        "x-api-key",
        "x-auth-token",
    }
)
"""Header names whose values are always removed before serialization."""

_SENSITIVE_QUERY_NAMES: Final = frozenset(
    {
        "access_token",
        "access-token",
        "api_key",
        "apikey",
        "auth",
        "client_secret",
        "credential",
        "key",
        "passwd",
        "password",
        "secret",
        "session_token",
        "sig",
        "signature",
        "token",
    }
)
"""Query parameter names whose values are always removed from URLs."""

_SENSITIVE_FIELD_NAMES: Final = _SENSITIVE_HEADER_NAMES | _SENSITIVE_QUERY_NAMES
"""Structured field names whose values are removed inside typed payloads."""

_URL_PATTERN: Final = re.compile(r"(?i)\bhttps?://[^\s<>\"']+")
_HF_ACCESS_TOKEN_PATTERN: Final = re.compile(r"\bhf_[A-Za-z0-9]{20,}\b")
_HF_ORG_TOKEN_PATTERN: Final = re.compile(r"\bapi_org_[A-Za-z0-9]{20,}\b")
_HEADER_NAMES_ALTERNATION: Final = "|".join(sorted(_SENSITIVE_HEADER_NAMES))
"""Deterministic alternation of every sensitive header name."""

_CREDENTIAL_FIELD_ALTERNATION: Final = "passphrase|password|token|username"
"""Credential-field names recognized in AskPass prompts and Git protocol."""

_HEADER_LINE_PATTERN: Final = re.compile(
    "(?im)^(?P<name>(?:" + _HEADER_NAMES_ALTERNATION + r")\s*:\s*).*$"
)
_GIT_CREDENTIAL_LINE_PATTERN: Final = re.compile(
    r"(?im)^(?P<head>\s*(?:" + _CREDENTIAL_FIELD_ALTERNATION + r")\s*=\s*).*$"
)
_ASKPASS_PROMPT_PATTERN: Final = re.compile(
    r"(?im)^(?P<prefix>\s*(?:"
    + _CREDENTIAL_FIELD_ALTERNATION
    + r")\s+for\s+'[^']*'\s*:)\s*\S.*$"
)


@dataclass(frozen=True, slots=True)
class RedactionError(ValueError):
    """A redaction contract was violated before any serialization occurred."""

    reason: str

    @override
    def __str__(self) -> str:
        return f"redaction error: {self.reason}"


def _redact_urls(text: str) -> str:
    """Replace every HTTP(S) URL with a structurally redacted equivalent."""
    return _URL_PATTERN.sub(lambda match: _redact_url(match.group(0)), text)


def _redact_url(url: str) -> str:
    """Redact one URL by parsing structure: userinfo and sensitive query values."""
    parsed = urlsplit(url)
    netloc = _redact_netloc(parsed.netloc, parsed.hostname, parsed.port)
    query = _redact_query(parsed.query)
    return urlunsplit((parsed.scheme, netloc, parsed.path, query, parsed.fragment))


def _redact_netloc(netloc: str, hostname: str | None, port: int | None) -> str:
    """Replace userinfo with a marker while preserving the host and port."""
    if "@" not in netloc:
        return netloc
    host = hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    suffix = f":{port}" if port is not None else ""
    return f"{REDACTED}@{host}{suffix}"


def _redact_query(query: str) -> str:
    """Redact sensitive query values surgically, leaving other pairs untouched."""
    if not query:
        return query
    pairs: list[str] = []
    for pair in query.split("&"):
        if "=" not in pair:
            pairs.append(pair)
            continue
        name, _, _ = pair.partition("=")
        if unquote(name).casefold() in _SENSITIVE_QUERY_NAMES:
            pairs.append(f"{name}={REDACTED}")
        else:
            pairs.append(pair)
    return "&".join(pairs)


def _redact_header_lines(text: str) -> str:
    """Redact credential-bearing header lines by name in captured HTTP text."""
    return _HEADER_LINE_PATTERN.sub(
        lambda match: f"{match.group('name')}{REDACTED}", text
    )


def _redact_git_credential_lines(text: str) -> str:
    """Redact Git credential-protocol alias and password lines."""
    return _GIT_CREDENTIAL_LINE_PATTERN.sub(
        lambda match: f"{match.group('head')}{REDACTED}", text
    )


def _redact_askpass_prompts(text: str) -> str:
    """Redact any value echoed after an AskPass prompt on the same line."""
    return _ASKPASS_PROMPT_PATTERN.sub(
        lambda match: f"{match.group('prefix')} {REDACTED}", text
    )


def _apply_registered_secrets(text: str, registry: SecretRegistry) -> str:
    """Replace every registered secret by value, longest matches first."""
    for secret in sorted(registry.registered_values(), key=len, reverse=True):
        if secret in text:
            text = text.replace(secret, REDACTED)
    return text


def _is_sensitive_field_name(name: str) -> bool:
    """Return whether a structured field name carries a credential value."""
    return name.casefold() in _SENSITIVE_FIELD_NAMES


def _iter_exception_chain(error: BaseException) -> Iterator[BaseException]:
    """Yield an exception followed by its cause and then its context chain."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None:
        if id(current) in seen:
            return
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


class SecretRegistry:
    """Process-local secrets redacted by value, with a bounded lifetime."""

    __slots__: Final = ("_values",)
    _values: set[str]

    def __init__(self) -> None:
        """Create an empty process-local secret registry."""
        self._values = set()

    def register(self, secret: str) -> None:
        """Register one secret value for redaction by value."""
        if not secret:
            raise RedactionError(reason="a registered secret must be non-empty")
        self._values.add(secret)

    def unregister(self, secret: str) -> None:
        """Stop redacting one secret value."""
        self._values.discard(secret)

    @contextmanager
    def bound(self, *secrets: str) -> Generator[None, None, None]:
        """Register secrets only for the duration of the surrounding context."""
        for secret in secrets:
            self.register(secret)
        try:
            yield
        finally:
            for secret in secrets:
                self._values.discard(secret)

    def registered_values(self) -> frozenset[str]:
        """Return the live values; the redactor seam, never for serialization."""
        return frozenset(self._values)

    @override
    def __repr__(self) -> str:
        return f"SecretRegistry(registered={len(self._values)})"

    @override
    def __str__(self) -> str:
        return f"SecretRegistry(registered={len(self._values)})"


class Redactor:
    """Removes secrets from diagnostics before they cross a serialization boundary."""

    __slots__: Final = ("_registry",)
    _registry: SecretRegistry | None

    def __init__(self, registry: SecretRegistry | None = None) -> None:
        """Create a redactor that consults an optional secret registry."""
        self._registry = registry

    def redact_text(self, text: str) -> str:
        """Redact one arbitrary string, combining structural and pattern rules."""
        value = _redact_urls(text)
        value = _redact_header_lines(value)
        value = _redact_git_credential_lines(value)
        value = _redact_askpass_prompts(value)
        value = _HF_ACCESS_TOKEN_PATTERN.sub(REDACTED, value)
        value = _HF_ORG_TOKEN_PATTERN.sub(REDACTED, value)
        if self._registry is not None:
            value = _apply_registered_secrets(value, self._registry)
        return value

    def redact_value(self, value: JsonValue) -> JsonValue:
        """Redact a JSON-safe value recursively before serialization."""
        match value:
            case str() as text:
                return self.redact_text(text)
            case bool() | int() | float() | None:
                return value
            case list():
                return [self.redact_value(item) for item in value]
            case dict():
                return self.redact_fields(value)

    def redact_fields(self, fields: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        """Redact one string-keyed mapping, honoring sensitive field names."""
        return {
            key: REDACTED if _is_sensitive_field_name(key) else self.redact_value(value)
            for key, value in fields.items()
        }

    def redact_payload(self, value: object) -> JsonValue:
        """Normalize any diagnostic object and redact it into JSON-safe form."""
        if isinstance(value, BaseModel):
            return self.redact_value(value.model_dump(mode="python"))
        if is_dataclass(value) and not isinstance(value, type):
            return self.redact_value(asdict(value))
        if isinstance(value, bytes):
            return self._redact_bytes_payload(value)
        if isinstance(value, Path):
            return self.redact_value(str(value))
        if value is None or isinstance(value, (str, int, float, bool)):
            return self.redact_value(value)
        raise RedactionError(
            reason=f"unsupported diagnostic payload of type {type(value).__name__}"
        )

    def redact_exception(self, error: BaseException) -> str:
        """Render an exception chain with redacted messages and type context."""
        rendered = "\n".join(
            f"{type(item).__name__}: {str(item) or type(item).__name__}"
            for item in _iter_exception_chain(error)
        )
        return self.redact_text(rendered)

    def _redact_bytes_payload(self, raw: bytes) -> JsonValue:
        """Decode UTF-8 payload text and redact it, keeping binary opaque."""
        try:
            decoded = raw.decode("utf-8")
        except UnicodeDecodeError:
            return self.redact_value(repr(raw))
        return self.redact_value(decoded)
