"""Structured logging pipeline with development and support-bundle sinks."""

from __future__ import annotations

import json
import sys
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Final, Protocol

from .events import EVENT_SINK_FAILED, EVENT_SINK_OPENED, Event
from .exceptions import InvalidLogLevelError

if TYPE_CHECKING:
    from collections.abc import Mapping
    from typing import TextIO

    from hubfetch.security.redaction import Redactor

    from .events import EventLevel, EventValue, SupportEvent

_SUPPORTED_LEVELS: Final = ("debug", "info", "warn", "error")
"""Every event level a logger sink threshold may name."""

_LEVEL_RANK: Final = {level: rank for rank, level in enumerate(_SUPPORTED_LEVELS)}
"""Ordering used to filter events per sink by the named consumer."""

_DEV_THRESHOLD: Final = "debug"
"""The development consumer sees every event at debug and above."""


def validate_log_level(level: str) -> EventLevel:
    """Return a level string that names a supported consumer threshold."""
    if level not in _SUPPORTED_LEVELS:
        raise InvalidLogLevelError(level=level)
    return level


class Clock(Protocol):
    """Source of the wall-clock instant used for event timestamps."""

    def now(self) -> datetime:
        """Return the current instant."""
        ...


class _UtcClock:
    """Default clock reading the current UTC instant."""

    def now(self) -> datetime:
        return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class LoggerSinks:
    """Output channels split by consumer: dev, support bundle, and last resort."""

    dev: TextIO | None = None
    jsonl: TextIO | None = None
    last_resort: TextIO = sys.stderr


class StructuredLogger:
    """One structured pipeline: readable dev output plus parseable JSONL."""

    __slots__: Final = ("_clock", "_level", "_redactor", "_sinks")
    _clock: Clock
    _level: EventLevel
    _redactor: Redactor
    _sinks: LoggerSinks

    def __init__(
        self,
        redactor: Redactor,
        *,
        sinks: LoggerSinks | None = None,
        level: EventLevel = "info",
        clock: Clock | None = None,
    ) -> None:
        """Create a pipeline that routes redacted events to its sinks."""
        self._redactor = redactor
        self._sinks = sinks if sinks is not None else LoggerSinks()
        self._level = validate_log_level(level)
        self._clock = clock if clock is not None else _UtcClock()
        self.info(
            EVENT_SINK_OPENED,
            "structured logging pipeline ready",
            fields={
                "dev": self._sinks.dev is not None,
                "jsonl": self._sinks.jsonl is not None,
            },
        )

    def debug(
        self,
        event_name: str,
        message: str,
        *,
        fields: Mapping[str, EventValue] | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Emit a debug event visible only to the development consumer."""
        self._log("debug", event_name, message, fields, correlation_id)

    def info(
        self,
        event_name: str,
        message: str,
        *,
        fields: Mapping[str, EventValue] | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Emit an info event that reconstructs the transfer timeline."""
        self._log("info", event_name, message, fields, correlation_id)

    def warn(
        self,
        event_name: str,
        message: str,
        *,
        fields: Mapping[str, EventValue] | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Emit a warning about an abnormal but recoverable path."""
        self._log("warn", event_name, message, fields, correlation_id)

    def error(
        self,
        event_name: str,
        message: str,
        *,
        fields: Mapping[str, EventValue] | None = None,
        exception: BaseException | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """Emit an error event carrying a redacted exception rendering."""
        event_fields = dict(fields or {})
        if exception is not None:
            event_fields["exception"] = self._redactor.redact_exception(exception)
        self._log("error", event_name, message, event_fields, correlation_id)

    def close(self) -> None:
        """Flush every configured sink so artifacts are complete."""
        for sink in (self._sinks.dev, self._sinks.jsonl):
            if sink is not None:
                with suppress(OSError, ValueError):
                    sink.flush()
        with suppress(OSError, ValueError):
            self._sinks.last_resort.flush()

    def _log(
        self,
        level: EventLevel,
        event_name: str,
        message: str,
        fields: Mapping[str, EventValue] | None,
        correlation_id: str | None,
    ) -> None:
        event = Event(
            name=event_name,
            level=level,
            timestamp=self._timestamp(),
            message=message,
            fields=dict(fields or {}),
            correlation_id=correlation_id,
        )
        support = event.to_support(self._redactor)
        if (
            self._sinks.jsonl is not None
            and _LEVEL_RANK[level] >= _LEVEL_RANK[self._level]
        ):
            self._write_jsonl(self._sinks.jsonl, support)
        if (
            self._sinks.dev is not None
            and _LEVEL_RANK[level] >= _LEVEL_RANK[_DEV_THRESHOLD]
        ):
            self._write_dev(self._sinks.dev, support)

    def _timestamp(self) -> str:
        return self._clock.now().isoformat()

    def _write_jsonl(self, jsonl_sink: TextIO, support: SupportEvent) -> None:
        try:
            _ = jsonl_sink.write(f"{json.dumps(support, sort_keys=True)}\n")
        except (OSError, ValueError) as error:
            self._report_sink_failure("jsonl", error)

    def _write_dev(self, dev_sink: TextIO, support: SupportEvent) -> None:
        parts = [
            support["timestamp"],
            support["level"].upper().ljust(5),
            support["event"],
            support["message"],
        ]
        if support["correlation_id"] is not None:
            parts.append(f"correlation_id={support['correlation_id']}")
        if support["fields"]:
            parts.append(f"fields={json.dumps(support['fields'], sort_keys=True)}")
        try:
            _ = dev_sink.write(f"{' '.join(parts)}\n")
        except (OSError, ValueError) as error:
            self._report_sink_failure("dev", error)

    def _report_sink_failure(self, sink_name: str, error: OSError | ValueError) -> None:
        reason = self._redactor.redact_text(str(error))
        line = (
            f"{self._timestamp()} WARN  {EVENT_SINK_FAILED} "
            f"{sink_name} sink write failed reason={reason}"
        )
        with suppress(OSError, ValueError):
            _ = self._sinks.last_resort.write(f"{line}\n")


def sanitize_worker_stderr(redactor: Redactor, text: str) -> str:
    """Redact captured worker stderr before it crosses into any diagnostic sink."""
    return redactor.redact_text(text)
