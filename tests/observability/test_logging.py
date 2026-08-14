"""Tests for the structured logging pipeline and support-bundle output."""

from __future__ import annotations

import json
from io import StringIO
from typing import Final, override

import pytest
from pydantic import TypeAdapter

from hubfetch.observability.events import EVENT_SINK_OPENED, Event, SupportEvent
from hubfetch.observability.exceptions import (
    InvalidEventNameError,
    InvalidLogLevelError,
)
from hubfetch.observability.logging import (
    LoggerSinks,
    StructuredLogger,
    sanitize_worker_stderr,
    validate_log_level,
)
from hubfetch.security.redaction import REDACTED, Redactor, SecretRegistry
from tests.conftest import HF_TEST_SECRET
from tests.helpers.clock import ControllableClock

SENTINEL: Final = HF_TEST_SECRET
DISK_FULL: Final = "disk full"
SUPPORT_ADAPTER: Final = TypeAdapter(SupportEvent)


class FailingSink(StringIO):
    """A support-bundle sink whose writes always fail."""

    @override
    def write(self, value: str) -> int:
        raise OSError(DISK_FULL)


def parse_jsonl(text: str) -> list[SupportEvent]:
    """Parse one typed support record per JSONL line."""
    return [SUPPORT_ADAPTER.validate_json(line) for line in text.splitlines()]


def test_pipeline_emits_parseable_jsonl_with_redacted_fields() -> None:
    """Given structured fields, JSONL is parseable and secrets are removed."""
    jsonl = StringIO()
    pipeline = StructuredLogger(
        Redactor(), sinks=LoggerSinks(jsonl=jsonl), clock=ControllableClock()
    )
    pipeline.info(
        "transfer.started",
        "hub transfer started",
        fields={
            "repo": "org/model",
            "url": f"https://alice:{SENTINEL}@example.com/repo",
            "token": SENTINEL,
        },
        correlation_id="task-1",
    )
    pipeline.close()

    records = parse_jsonl(jsonl.getvalue())
    events = {record["event"] for record in records}
    assert EVENT_SINK_OPENED in events
    assert "transfer.started" in events
    record = next(record for record in records if record["event"] == "transfer.started")
    assert record["fields"]["token"] == REDACTED
    assert record["fields"]["url"] == f"https://{REDACTED}@example.com/repo"
    assert record["fields"]["repo"] == "org/model"
    assert record["correlation_id"] == "task-1"
    assert SENTINEL not in jsonl.getvalue()


def test_error_exception_serialization_preserves_type_and_message() -> None:
    """Given a chained exception, the support bundle keeps type and message."""
    jsonl = StringIO()
    registry = SecretRegistry()
    registry.register(SENTINEL)
    inner = RuntimeError(f"connection reset with {SENTINEL}")
    outer = ValueError("hub request failed")
    outer.__cause__ = inner
    pipeline = StructuredLogger(
        Redactor(registry=registry),
        sinks=LoggerSinks(jsonl=jsonl),
        clock=ControllableClock(),
    )
    pipeline.error(
        "transfer.failed",
        "hub transfer failed",
        exception=outer,
        fields={"repo": "org/model"},
    )
    pipeline.close()

    records = parse_jsonl(jsonl.getvalue())
    record = next(record for record in records if record["event"] == "transfer.failed")
    exception_text = record["fields"]["exception"]
    assert isinstance(exception_text, str)
    assert "RuntimeError" in exception_text
    assert "ValueError" in exception_text
    assert "hub request failed" in exception_text
    assert SENTINEL not in exception_text
    assert REDACTED in exception_text


def test_error_message_is_redacted_in_the_record() -> None:
    """Given a secret inside the message, the record message is redacted."""
    jsonl = StringIO()
    registry = SecretRegistry()
    registry.register(SENTINEL)
    pipeline = StructuredLogger(
        Redactor(registry=registry),
        sinks=LoggerSinks(jsonl=jsonl),
        clock=ControllableClock(),
    )
    pipeline.error("hub.failed", f"hub call failed with {SENTINEL}")
    pipeline.close()

    records = parse_jsonl(jsonl.getvalue())
    record = next(record for record in records if record["event"] == "hub.failed")
    assert record["message"] == f"hub call failed with {REDACTED}"
    assert SENTINEL not in jsonl.getvalue()


def test_debug_events_are_suppressed_from_the_support_bundle() -> None:
    """Given a debug trace, only the development sink receives it."""
    dev = StringIO()
    jsonl = StringIO()
    registry = SecretRegistry()
    registry.register(SENTINEL)
    pipeline = StructuredLogger(
        Redactor(registry=registry),
        sinks=LoggerSinks(dev=dev, jsonl=jsonl),
        clock=ControllableClock(),
    )
    pipeline.debug("transfer.sniffing", "tracing detail", fields={"scratch": SENTINEL})
    pipeline.close()

    assert "transfer.sniffing" not in jsonl.getvalue()
    assert "transfer.sniffing" in dev.getvalue()
    assert SENTINEL not in dev.getvalue()


def test_dev_output_is_readable_and_redacted() -> None:
    """Given a normal event, the development line stays human-readable."""
    dev = StringIO()
    pipeline = StructuredLogger(
        Redactor(), sinks=LoggerSinks(dev=dev), clock=ControllableClock()
    )
    pipeline.info(
        "transfer.started",
        "hub transfer started",
        fields={
            "repo": "org/model",
            "url": f"https://u:{SENTINEL}@example.com/repo",
        },
    )
    pipeline.close()

    output = dev.getvalue()
    assert "INFO" in output
    assert "transfer.started" in output
    assert "hub transfer started" in output
    assert f"{REDACTED}@example.com/repo" in output
    assert SENTINEL not in output


def test_jsonl_threshold_is_configurable() -> None:
    """Given a warn-only support threshold, info events stay out of JSONL."""
    jsonl = StringIO()
    pipeline = StructuredLogger(
        Redactor(),
        sinks=LoggerSinks(jsonl=jsonl),
        level="warn",
        clock=ControllableClock(),
    )
    pipeline.info("transfer.started", "hub transfer started")
    pipeline.warn("hub.rate_limited", "rate limit engaged", fields={"retry_after": 5})
    pipeline.close()

    records = parse_jsonl(jsonl.getvalue())
    events = {record["event"] for record in records}
    assert "transfer.started" not in events
    assert "hub.rate_limited" in events


def test_invalid_event_name_is_rejected() -> None:
    """Given a non-dotted event name, logging fails with a typed error."""
    pipeline = StructuredLogger(
        Redactor(),
        sinks=LoggerSinks(jsonl=StringIO()),
        clock=ControllableClock(),
    )

    with pytest.raises(InvalidEventNameError):
        pipeline.info("Transfer Started", "bad name")


def test_invalid_log_level_is_rejected() -> None:
    """Given an unknown threshold string, validation fails with a typed error."""
    with pytest.raises(InvalidLogLevelError):
        _ = validate_log_level("verbose")


def test_broken_support_sink_degrades_gracefully() -> None:
    """Given a failing JSONL sink, logging warns through the last resort."""
    last_resort = StringIO()
    pipeline = StructuredLogger(
        Redactor(),
        sinks=LoggerSinks(jsonl=FailingSink(), last_resort=last_resort),
        clock=ControllableClock(),
    )
    pipeline.error(
        "transfer.failed",
        "hub transfer failed",
        exception=RuntimeError("boom"),
    )
    pipeline.close()

    assert "logging.sink.failed" in last_resort.getvalue()
    assert DISK_FULL in last_resort.getvalue()


def test_event_support_model_redacts_nested_fields() -> None:
    """Given nested event fields, the support model removes every secret."""
    event = Event(
        name="transfer.failed",
        level="error",
        timestamp="2026-01-01T00:00:00+00:00",
        message="hub transfer failed",
        fields={
            "auth": {"token": SENTINEL},
            "url": f"https://alice:{SENTINEL}@example.com",
        },
    )

    support = event.to_support(Redactor())

    assert SENTINEL not in json.dumps(support)
    fields = support["fields"]
    assert isinstance(fields, dict)
    assert fields["auth"] == REDACTED
    assert fields["url"] == f"https://{REDACTED}@example.com"
    assert support["event"] == "transfer.failed"


def test_worker_stderr_is_sanitized() -> None:
    """Given captured worker stderr, secrets are removed before storage."""
    stderr = f"fatal: remote error: {SENTINEL}\nAuthorization: Bearer {SENTINEL}\n"
    registry = SecretRegistry()
    registry.register(SENTINEL)

    cleaned = sanitize_worker_stderr(Redactor(registry=registry), stderr)

    assert SENTINEL not in cleaned
    assert "fatal: remote error" in cleaned
    assert "Authorization: [REDACTED]" in cleaned


def test_no_sentinel_bytes_in_any_logging_artifact() -> None:
    """Given every event level, serialized artifacts hold no sentinel bytes."""
    dev = StringIO()
    jsonl = StringIO()
    registry = SecretRegistry()
    registry.register(SENTINEL)
    pipeline = StructuredLogger(
        Redactor(registry=registry),
        sinks=LoggerSinks(dev=dev, jsonl=jsonl),
        clock=ControllableClock(),
    )
    pipeline.info(
        "hub.ping",
        "ping",
        fields={"token": SENTINEL, "url": f"https://u:{SENTINEL}@example.com"},
    )
    pipeline.warn("hub.rate_limited", "rate limited", fields={"retry_after": 5})
    pipeline.error("hub.pong", "pong", exception=RuntimeError(SENTINEL))
    pipeline.close()

    artifacts = [dev.getvalue(), jsonl.getvalue()]
    for artifact in artifacts:
        assert SENTINEL.encode("utf-8") not in artifact.encode("utf-8")
