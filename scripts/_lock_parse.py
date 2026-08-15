"""Parsing of uv.lock and license_overrides.toml into typed models.

The module owns every byte-level parser behind the license policy: the
Windows-filtered ``uv.lock`` package model, the PEP 508 environment-marker
evaluator, and the curated overrides document. Each parse is a pure function
of its input text, so notice generation stays deterministic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

WINDOWS_FACTS: Final[Mapping[str, str]] = {
    "sys_platform": "win32",
    "platform_machine": "AMD64",
    "platform_python_implementation": "CPython",
    "implementation_name": "cpython",
    "python_version": "3.12",
    "python_full_version": "3.12.4",
    "os_name": "nt",
}

# Package blocks produced by split("[[package]]") start with a newline, so
# these anchors must be line anchors, not string anchors.
_NAME_LINE: Final = re.compile(r'^name = "([^"]+)"$', re.MULTILINE)
_VERSION_LINE: Final = re.compile(r'^version = "([^"]+)"$', re.MULTILINE)
_EDITABLE_SOURCE: Final = re.compile(r"^source = \{[^}]*editable[^}]*\}$", re.MULTILINE)
_DEP_ENTRY: Final = re.compile(
    r'\{\s*name = "([^"]+)"(?:\s*,\s*marker = "([^"]*)")?\s*\}'
)
_TOKEN: Final = re.compile(
    r"\(|\)|==|!=|\band\b|\bor\b|\bnot\b|'[^']*'|[A-Za-z_][A-Za-z0-9_]*"
)
_STRING_LINE: Final = re.compile(r'^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"$')
_BOOL_LINE: Final = re.compile(r"^([A-Za-z0-9_.-]+)\s*=\s*true$")


@dataclass(frozen=True, slots=True)
class LockDependency:
    """One dependency edge of a locked package."""

    name: str
    marker: str | None


@dataclass(frozen=True, slots=True)
class LockPackage:
    """One package from uv.lock."""

    name: str
    version: str
    dependencies: tuple[LockDependency, ...]
    is_project: bool


@dataclass(frozen=True, slots=True)
class LockModel:
    """The packages declared by a uv.lock document."""

    packages: tuple[LockPackage, ...]


@dataclass(frozen=True, slots=True)
class ProjectInfo:
    """Immutable identity of the project that owns the notices."""

    name: str
    version: str
    license: str


@dataclass(frozen=True, slots=True)
class Overrides:
    """Curated license and homepage mapping with policy sets."""

    project: ProjectInfo
    licenses: Mapping[str, str]
    homepages: Mapping[str, str]
    allowed_licenses: frozenset[str]
    disallowed_licenses: frozenset[str]


@final
class _MarkerParser:
    """Recursive-descent parser for the PEP 508 marker subset in uv.lock."""

    _tokens: Sequence[str]
    _facts: Mapping[str, str]
    _index: int

    def __init__(self, tokens: Sequence[str], facts: Mapping[str, str]) -> None:
        self._tokens = tokens
        self._facts = facts
        self._index = 0

    def parse(self) -> bool:
        value = self._or_expression()
        if self._index != len(self._tokens):
            message = "trailing marker tokens"
            raise ValueError(message)
        return value

    def _or_expression(self) -> bool:
        left = self._and_expression()
        while self._peek("or"):
            self._index += 1
            right = self._and_expression()
            left = left or right
        return left

    def _and_expression(self) -> bool:
        left = self._not_expression()
        while self._peek("and"):
            self._index += 1
            right = self._not_expression()
            left = left and right
        return left

    def _not_expression(self) -> bool:
        if self._peek("not"):
            self._index += 1
            return not self._not_expression()
        if self._peek("("):
            self._index += 1
            value = self._or_expression()
            if not self._peek(")"):
                message = "unclosed marker parenthesis"
                raise ValueError(message)
            self._index += 1
            return value
        return self._comparison()

    def _comparison(self) -> bool:
        identifier = self._tokens[self._index]
        operator = self._tokens[self._index + 1]
        literal = self._tokens[self._index + 2].strip("'")
        self._index += 3
        actual = self._facts.get(identifier)
        if actual is None:
            return False
        match operator:
            case "==":
                return actual == literal
            case "!=":
                return actual != literal
            case _:
                message = f"unsupported marker operator: {operator}"
                raise ValueError(message)

    def _peek(self, token: str) -> bool:
        return self._index < len(self._tokens) and self._tokens[self._index] == token


def _tokenize(expression: str) -> tuple[str, ...]:
    return tuple(match.group(0) for match in _TOKEN.finditer(expression))


def marker_allows(marker: str | None) -> bool:
    if marker is None:
        return True
    return _MarkerParser(_tokenize(marker), WINDOWS_FACTS).parse()


def _extract_dependencies(block: str) -> tuple[LockDependency, ...]:
    start = block.find("dependencies = [")
    if start == -1:
        return ()
    rows: list[str] = []
    for line in block[start:].splitlines():
        if line.strip() == "]":
            break
        rows.append(line)
    dependencies = [
        LockDependency(match.group(1), match.group(2) or None)
        for match in _DEP_ENTRY.finditer("\n".join(rows))
    ]
    return tuple(dependencies)


def parse_lock(text: str) -> LockModel:
    """Parse the uv.lock document into a typed LockModel."""
    packages: list[LockPackage] = []
    for block in text.split("[[package]]"):
        if "name = " not in block:
            continue
        name_match = _NAME_LINE.search(block)
        version_match = _VERSION_LINE.search(block)
        if name_match is None:
            continue
        packages.append(
            LockPackage(
                name=name_match.group(1),
                version=version_match.group(1) if version_match else "",
                dependencies=_extract_dependencies(block),
                is_project=_EDITABLE_SOURCE.search(block) is not None,
            )
        )
    return LockModel(tuple(packages))


def _section_header(line: str) -> str | None:
    """Return the section name for a TOML header line, else None."""
    if line.startswith("[") and line.endswith("]"):
        return line[1:-1].strip()
    return None


def _override_entry(line: str) -> tuple[str, str] | None:
    """Return (key, value) for a TOML string or bool line, else None."""
    string_match = _STRING_LINE.match(line)
    if string_match is not None:
        return (string_match.group(1), string_match.group(2))
    bool_match = _BOOL_LINE.match(line)
    if bool_match is None:
        return None
    return (bool_match.group(1), "true")


def parse_overrides(text: str) -> Overrides:
    """Parse the curated packaging/license_overrides.toml document."""
    project_fields: dict[str, str] = {}
    licenses: dict[str, str] = {}
    homepages: dict[str, str] = {}
    allowed: dict[str, str] = {}
    disallowed: dict[str, str] = {}
    targets: dict[str, dict[str, str]] = {
        "project": project_fields,
        "licenses": licenses,
        "homepages": homepages,
        "allowed": allowed,
        "disallowed": disallowed,
    }
    section: str | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        header = _section_header(line)
        if header is not None:
            section = header
            continue
        if line == "" or line.startswith("#"):
            continue
        if section is None:
            continue
        entry = _override_entry(line)
        if entry is None:
            continue
        key, value = entry
        bucket = targets.get(section)
        if bucket is not None:
            bucket[key] = value
    if "name" not in project_fields:
        message = "overrides missing [project].name"
        raise ValueError(message)
    project = ProjectInfo(
        project_fields["name"],
        project_fields.get("version", ""),
        project_fields.get("license", ""),
    )
    return Overrides(
        project, licenses, homepages, frozenset(allowed), frozenset(disallowed)
    )
