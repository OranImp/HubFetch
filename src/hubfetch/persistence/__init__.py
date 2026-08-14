"""Transactional SQLite persistence: migrations, tasks, and settings."""

from __future__ import annotations

from .connection import (
    Clock,
    ConnectionOpenError,
    Transaction,
    TransactionError,
    decode_timestamp,
    encode_timestamp,
    open_connection,
)
from .migrations import (
    SCHEMA_VERSION,
    UnsupportedSchemaVersionError,
    current_schema_version,
    migrate,
)

__all__ = [
    "SCHEMA_VERSION",
    "Clock",
    "ConnectionOpenError",
    "Transaction",
    "TransactionError",
    "UnsupportedSchemaVersionError",
    "current_schema_version",
    "decode_timestamp",
    "encode_timestamp",
    "migrate",
    "open_connection",
]
