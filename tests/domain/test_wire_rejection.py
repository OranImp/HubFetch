"""Tests for strict rejection of malformed or secret-bearing wire lines."""

from __future__ import annotations

import pytest

from hubfetch.domain.ipc import IpcDecodeError, decode_wire


def test_decode_wire_rejects_unknown_tags_without_echoing_values() -> None:
    """Given an unknown kind tag, decoding fails typed and value-free."""
    with pytest.raises(IpcDecodeError) as caught:
        _ = decode_wire('{"kind": "bogus_variant"}')

    assert any(detail.code == "union_tag_invalid" for detail in caught.value.details)
    assert "bogus_variant" not in str(caught.value)


def test_decode_wire_rejects_token_payload_without_echoing_secret() -> None:
    """Given a token payload, decoding fails without echoing the value."""
    with pytest.raises(IpcDecodeError) as caught:
        _ = decode_wire('{"kind": "shutdown", "token": "hf_test_secret_123"}')

    assert any(detail.code == "extra_forbidden" for detail in caught.value.details)
    assert any(detail.field_name == "shutdown.token" for detail in caught.value.details)
    assert "hf_test_secret_123" not in str(caught.value)


def test_decode_wire_rejects_empty_lines() -> None:
    """Given an empty or blank line, decoding fails typed."""
    for line in ("", "   \n", "\r\n"):
        with pytest.raises(IpcDecodeError):
            _ = decode_wire(line)


def test_decode_wire_rejects_malformed_json() -> None:
    """Given a non-JSON line, decoding fails typed."""
    with pytest.raises(IpcDecodeError):
        _ = decode_wire("this is not json")


def test_decode_wire_rejects_trailing_content_after_json_value() -> None:
    """Given trailing garbage after a JSON value, decoding fails typed."""
    with pytest.raises(IpcDecodeError):
        _ = decode_wire('{"kind": "shutdown"} trailing')


def test_decode_wire_rejects_unknown_fields_on_valid_tag() -> None:
    """Given an unknown field on a known tag, decoding fails typed."""
    with pytest.raises(IpcDecodeError):
        _ = decode_wire('{"kind": "shutdown", "unexpected_field": "ignored"}')
