"""Tests for structural and pattern redaction of HubFetch diagnostics."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import ClassVar, Final

import pytest
from pydantic import BaseModel, ConfigDict

from hubfetch.security.redaction import (
    REDACTED,
    RedactionError,
    Redactor,
    SecretRegistry,
)
from tests.conftest import HF_TEST_SECRET

SENTINEL: Final = HF_TEST_SECRET


@dataclass(frozen=True, slots=True)
class CredentialDump:
    """A typed value carrying a full credential alias and a token."""

    alias: str
    token: str
    host: str
    metadata: dict[str, str] = field(default_factory=dict)


class CredentialModel(BaseModel):
    """A strict typed model carrying a token alongside diagnostics."""

    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)

    token: str
    host: str
    proxies: dict[str, str] = {}


def test_url_userinfo_is_redacted_structurally() -> None:
    """Given a URL with userinfo, redaction keeps the host and path."""
    text = f"fetching https://alice:{SENTINEL}@example.com/releases now"

    sanitized = Redactor().redact_text(text)

    assert SENTINEL not in sanitized
    assert f"{REDACTED}@example.com/releases" in sanitized


def test_url_userinfo_with_port_preserves_the_port() -> None:
    """Given a userinfo URL with a port, redaction keeps the port."""
    sanitized = Redactor().redact_text(
        "https://alice:pass@example.com:8443/private?tab=1"
    )

    assert f"{REDACTED}@example.com:8443/private" in sanitized
    assert "tab=1" in sanitized


def test_access_token_query_value_is_redacted() -> None:
    """Given an access-token query parameter, only its value is removed."""
    sanitized = Redactor().redact_text(
        f"https://example.com/api?access_token={SENTINEL}&page=2"
    )

    assert SENTINEL not in sanitized
    assert f"access_token={REDACTED}" in sanitized
    assert "page=2" in sanitized


def test_authorization_header_is_redacted_by_name() -> None:
    """Given an Authorization header line, the value is removed by name."""
    sanitized = Redactor().redact_text(f"Authorization: Bearer {SENTINEL}")

    assert SENTINEL not in sanitized
    assert "Authorization: [REDACTED]" in sanitized


def test_cookie_header_is_redacted_by_name() -> None:
    """Given a Cookie header line, the value is removed by name."""
    sanitized = Redactor().redact_text(f"Cookie: session={SENTINEL}; theme=dark")

    assert SENTINEL not in sanitized
    assert "Cookie: [REDACTED]" in sanitized


def test_hugging_face_token_patterns_are_redacted() -> None:
    """Given token-shaped values, access and organization tokens are removed."""
    text = (
        "token hf_AbCdEf0123456789AbCdEf0123456789 "
        "and org api_org_AbCdEf0123456789AbCdEf0123456789"
    )

    sanitized = Redactor().redact_text(text)

    assert "hf_AbCdEf0123456789AbCdEf0123456789" not in sanitized
    assert "api_org_AbCdEf0123456789AbCdEf0123456789" not in sanitized
    assert sanitized.count(REDACTED) == 2


def test_git_credential_lines_are_redacted() -> None:
    """Given Git credential-protocol lines, alias and password are removed."""
    text = "username=alice\npassword=hf_test_secret_123\nprotocol=https\n"

    sanitized = Redactor().redact_text(text)

    assert SENTINEL not in sanitized
    assert "username=[REDACTED]" in sanitized
    assert "password=[REDACTED]" in sanitized
    assert "protocol=https" in sanitized


def test_askpass_prompt_response_is_redacted() -> None:
    """Given an AskPass prompt line, userinfo and echoed response are removed."""
    text = f"Password for 'https://alice@example.com': {SENTINEL}"

    sanitized = Redactor().redact_text(text)

    assert SENTINEL not in sanitized
    assert "Password for" in sanitized
    assert f"{REDACTED}@example.com" in sanitized
    assert sanitized.endswith(REDACTED)


def test_registered_secret_is_redacted_by_value() -> None:
    """Given a registered runtime secret, every occurrence is removed."""
    registry = SecretRegistry()
    registry.register(SENTINEL)
    redactor = Redactor(registry=registry)

    sanitized = redactor.redact_text(f"credential {SENTINEL} cached")

    assert SENTINEL not in sanitized
    assert sanitized == f"credential {REDACTED} cached"


def test_unregister_stops_value_redaction() -> None:
    """Given an unregistered secret, the value is no longer removed."""
    registry = SecretRegistry()
    registry.register(SENTINEL)
    registry.unregister(SENTINEL)

    assert SENTINEL in Redactor(registry=registry).redact_text(SENTINEL)


def test_registered_secret_lifetime_is_bounded_by_context_manager() -> None:
    """Given a bound context, secrets redact inside and reappear after exit."""
    registry = SecretRegistry()
    redactor = Redactor(registry=registry)

    with registry.bound(SENTINEL):
        assert SENTINEL not in redactor.redact_text(SENTINEL)

    assert SENTINEL in redactor.redact_text(SENTINEL)


def test_overlapping_registered_secrets_are_all_redacted() -> None:
    """Given nested registered secrets, the longest match wins deterministically."""
    registry = SecretRegistry()
    registry.register(SENTINEL)
    registry.register("test_secret_123")

    sanitized = Redactor(registry=registry).redact_text(f"vault={SENTINEL}")

    assert SENTINEL not in sanitized
    assert "test_secret_123" not in sanitized
    assert sanitized == f"vault={REDACTED}"


def test_registering_an_empty_secret_is_rejected() -> None:
    """Given an empty secret, registration fails with a typed error."""
    with pytest.raises(RedactionError):
        SecretRegistry().register("")


def test_registry_is_never_serialized() -> None:
    """Given a populated registry, its repr is safe and JSON serialization fails."""
    registry = SecretRegistry()
    registry.register(SENTINEL)

    assert "SecretRegistry" in repr(registry)
    assert "registered=1" in repr(registry)
    assert SENTINEL not in repr(registry)
    assert SENTINEL not in str(registry)
    with pytest.raises(TypeError):
        _ = json.dumps(registry)


def test_redact_value_recurses_over_nested_json_values() -> None:
    """Given nested JSON values, sensitive names and secrets are removed."""
    sanitized = Redactor().redact_value(
        {"token": SENTINEL, "nested": {"secret": SENTINEL}, "ports": [1, 2]}
    )

    assert isinstance(sanitized, dict)
    assert sanitized["token"] == REDACTED
    nested = sanitized["nested"]
    assert isinstance(nested, dict)
    assert nested["secret"] == REDACTED
    assert sanitized["ports"] == [1, 2]
    assert SENTINEL not in json.dumps(sanitized)


def test_redact_payload_recurses_through_dataclass_and_pydantic_fields() -> None:
    """Given typed objects, redaction recurses through every declared field."""
    redactor = Redactor()
    dataclass_payload = CredentialDump(
        alias="hub-user",
        token=SENTINEL,
        host="example.com",
        metadata={"token": SENTINEL, "label": "prod"},
    )

    sanitized_dataclass = redactor.redact_payload(dataclass_payload)

    assert isinstance(sanitized_dataclass, dict)
    assert sanitized_dataclass["token"] == REDACTED
    assert sanitized_dataclass["alias"] == "hub-user"
    assert sanitized_dataclass["host"] == "example.com"
    metadata = sanitized_dataclass["metadata"]
    assert isinstance(metadata, dict)
    assert metadata["token"] == REDACTED
    assert metadata["label"] == "prod"

    model_payload = CredentialModel(
        token=SENTINEL, host="example.com", proxies={"token": SENTINEL}
    )
    sanitized_model = redactor.redact_payload(model_payload)

    assert isinstance(sanitized_model, dict)
    assert sanitized_model["token"] == REDACTED
    assert sanitized_model["host"] == "example.com"
    proxies = sanitized_model["proxies"]
    assert isinstance(proxies, dict)
    assert proxies["token"] == REDACTED
    assert SENTINEL not in json.dumps(sanitized_model)


def test_redact_payload_redacts_utf8_bytes_and_passes_binary_through() -> None:
    """Given bytes payloads, UTF-8 text is redacted and opaque bytes stay safe."""
    registry = SecretRegistry()
    registry.register(SENTINEL)
    redactor = Redactor(registry=registry)

    assert redactor.redact_payload(f"key={SENTINEL}".encode()) == (f"key={REDACTED}")
    assert redactor.redact_payload(b"\xff\xfe\x00") == repr(b"\xff\xfe\x00")


def test_exception_chains_are_redacted() -> None:
    """Given a chained exception, every message is redacted with type context."""
    root = RuntimeError(f"socket peer {SENTINEL} unreachable")
    middle = ValueError("hub api call failed")
    middle.__cause__ = root
    top = OSError("worker aborted")
    top.__context__ = middle
    registry = SecretRegistry()
    registry.register(SENTINEL)

    rendered = Redactor(registry=registry).redact_exception(top)

    assert SENTINEL not in rendered
    assert "RuntimeError" in rendered
    assert "ValueError" in rendered
    assert "OSError" in rendered
    assert "worker aborted" in rendered
    assert REDACTED in rendered


def test_preserves_non_secret_diagnostics() -> None:
    """Given mixed diagnostics, only credential-bearing material is removed."""
    text = (
        "GET /api/v2/models/org/model HTTP/1.1\n"
        "Host: huggingface.co\n"
        "X-Custom-Id: abc123\n"
        "Cache-Control: no-cache\n"
        f"Authorization: Bearer {SENTINEL}\n"
    )

    sanitized = Redactor().redact_text(text)

    assert SENTINEL not in sanitized
    assert "GET /api/v2/models/org/model HTTP/1.1" in sanitized
    assert "Host: huggingface.co" in sanitized
    assert "X-Custom-Id: abc123" in sanitized
    assert "Authorization: [REDACTED]" in sanitized


def test_redaction_is_deterministic() -> None:
    """Given the same input twice, redaction produces identical output."""
    text = f"https://alice:{SENTINEL}@example.com/x?token={SENTINEL}&tab=1"
    redactor = Redactor()

    assert redactor.redact_text(text) == redactor.redact_text(text)


def test_redacted_outputs_contain_no_sentinel_bytes() -> None:
    """Given all redaction entry points, output artifacts hold no sentinel bytes."""
    registry = SecretRegistry()
    registry.register(SENTINEL)
    redactor = Redactor(registry=registry)
    artifacts = [
        redactor.redact_text(f"https://alice:{SENTINEL}@example.com?token={SENTINEL}"),
        redactor.redact_exception(RuntimeError(SENTINEL)),
        repr(registry),
        json.dumps(
            redactor.redact_value({"token": SENTINEL, "nested": {"secret": SENTINEL}})
        ),
    ]

    for artifact in artifacts:
        assert SENTINEL.encode("utf-8") not in artifact.encode("utf-8")
