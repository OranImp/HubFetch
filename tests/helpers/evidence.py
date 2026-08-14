"""Deterministic evidence file writers for per-run test artifacts."""

from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final
from uuid import uuid4

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence
    from pathlib import Path

type JsonValue = (
    str | int | float | bool | list[JsonValue] | dict[str, JsonValue] | None
)

FIXED_PATH_PATTERN: Final = re.compile(
    r"(?i)^[a-z]:[\\/]|[\\/](?:tmp|shared|fixed-temp|test-temp)(?:[\\/]|$)"
)
FIXED_PORT_PATTERN: Final = re.compile(r"(?:127\.0\.0\.1|localhost):[1-9][0-9]{2,4}")


@dataclass(frozen=True, slots=True)
class ProcessCommandSnapshot:
    """Capture argv and explicitly supplied environment values."""

    argv: tuple[str, ...]
    environment: tuple[tuple[str, str], ...]


def capture_process_command(
    argv: Sequence[str], environment: Mapping[str, str] | None = None
) -> ProcessCommandSnapshot:
    """Return normalized, assertion-friendly process launch metadata."""
    values = tuple(sorted((environment or {}).items()))
    return ProcessCommandSnapshot(argv=tuple(argv), environment=values)


@dataclass(frozen=True, slots=True)
class PolicyViolation:
    """Describe a forbidden test source construct."""

    path: Path
    line: int
    rule: str
    detail: str

    def render(self) -> str:
        """Render a file-and-line diagnostic for evidence."""
        return f"{self.path}:{self.line}: [{self.rule}] {self.detail}"


def scan_test_source_policy(paths: Iterable[Path]) -> tuple[PolicyViolation, ...]:
    """Reject sleep synchronization and fixed shared path/port literals."""
    files = tuple(
        sorted(
            path.resolve()
            for candidate in paths
            for path in (
                candidate.rglob("*.py") if candidate.is_dir() else (candidate,)
            )
        )
    )
    violations: list[PolicyViolation] = []
    for path in files:
        source = path.read_text(encoding="utf-8")
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as error:
            violations.append(
                PolicyViolation(path, error.lineno or 1, "syntax-error", error.msg)
            )
            continue
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "sleep"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "time"
            ):
                violations.append(
                    PolicyViolation(
                        path, node.lineno, "no-sleep", "use an event or bounded wait"
                    )
                )
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if FIXED_PATH_PATTERN.search(node.value):
                    violations.append(
                        PolicyViolation(
                            path, node.lineno, "fixed-path", "use a per-run root"
                        )
                    )
                if FIXED_PORT_PATTERN.search(node.value):
                    violations.append(
                        PolicyViolation(path, node.lineno, "fixed-port", "bind port 0")
                    )
    return tuple(violations)


def normalize_evidence_name(value: str) -> str:
    """Normalize a human label into a stable filesystem-safe stem."""
    normalized = re.sub(r"[^a-z0-9]+", "_", value.casefold()).strip("_")
    return normalized or "evidence"


@final
class EvidenceWriter:
    """Write normalized text, JSON, and PNG evidence under one run root."""

    __slots__: Final = ("_root",)
    _root: Path

    def __init__(self, parent: Path, namespace: str) -> None:
        parent.mkdir(parents=True, exist_ok=True)
        root_name = f"{normalize_evidence_name(namespace)}-{uuid4().hex}"
        self._root = parent / root_name
        self._root.mkdir()

    @property
    def root(self) -> Path:
        """Return the unique per-run evidence directory."""
        return self._root

    def write_text(self, name: str, content: str) -> Path:
        """Write UTF-8 text evidence and return its path."""
        path = self._path(name, ".txt")
        _ = path.write_text(content, encoding="utf-8")
        return path

    def write_json(self, name: str, payload: JsonValue) -> Path:
        """Write sorted, indented JSON evidence and return its path."""
        path = self._path(name, ".json")
        serialized = json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True)
        _ = path.write_text(f"{serialized}\n", encoding="utf-8")
        return path

    def write_png(self, name: str, content: bytes) -> Path:
        """Write PNG bytes without interpreting or transforming the image."""
        path = self._path(name, ".png")
        _ = path.write_bytes(content)
        return path

    def _path(self, name: str, suffix: str) -> Path:
        return self._root / f"{normalize_evidence_name(name)}{suffix}"
