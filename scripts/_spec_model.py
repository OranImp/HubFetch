"""Declarative model and AST extraction for the PyInstaller spec document.

The module parses ``packaging/hubfetch.spec`` as declarative Python without
executing it, exposing the EXE/COLLECT structure and module-level constants
that the policy rules in scripts/check_package_policy.py assert against.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, final

if TYPE_CHECKING:
    from pathlib import Path

type LiteralScalar = str | int | float | bool
type LiteralValue = LiteralScalar | tuple[LiteralValue, ...]


@dataclass(frozen=True, slots=True)
class EntryPoint:
    """One executable declared by the spec."""

    name: str
    console: bool


@dataclass(frozen=True, slots=True)
class SpecModel:
    """Declarative content extracted from a PyInstaller spec."""

    entrypoints: tuple[EntryPoint, ...]
    collect_name: str | None
    upx: bool
    one_file: bool
    resource_plan: tuple[tuple[str, str], ...]
    hidden_imports: tuple[str, ...]
    excludes: tuple[str, ...]
    expected_qt_dlls: tuple[str, ...]
    uses_dynamic_qt: bool


@final
class _SpecParser:
    """AST-based extractor for the declarative spec constants."""

    def __init__(self, tree: ast.Module, source: str) -> None:
        self._tree = tree
        self._source = source

    def parse(self) -> SpecModel:
        entrypoints = tuple(
            EntryPoint(name, console) for name, console in self._exe_declarations()
        )
        collect = self._collect_name()
        upx, one_file = self._prohibited_flags()
        constants = self._module_constants()
        return SpecModel(
            entrypoints=entrypoints,
            collect_name=collect,
            upx=upx,
            one_file=one_file,
            resource_plan=_tuple_of_pairs(constants.get("RESOURCE_PLAN")),
            hidden_imports=_tuple_of_strings(constants.get("HIDDEN_IMPORTS")),
            excludes=_tuple_of_strings(constants.get("EXCLUDES")),
            expected_qt_dlls=_tuple_of_strings(constants.get("EXPECTED_QT_DLLS")),
            uses_dynamic_qt="collect_dynamic_libs" in self._source
            and "PySide6" in self._source,
        )

    def _exe_declarations(self) -> tuple[tuple[str, bool], ...]:
        declarations: list[tuple[str, bool]] = []
        for node in ast.walk(self._tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "EXE":
                continue
            name, console = "?", True
            for keyword in node.keywords:
                if keyword.arg == "name" and isinstance(keyword.value, ast.Constant):
                    name = str(keyword.value.value)
                elif keyword.arg == "console" and isinstance(
                    keyword.value, ast.Constant
                ):
                    console = bool(keyword.value.value)
            declarations.append((name, console))
        return tuple(declarations)

    def _collect_name(self) -> str | None:
        for node in ast.walk(self._tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "COLLECT":
                continue
            for keyword in node.keywords:
                if keyword.arg == "name" and isinstance(keyword.value, ast.Constant):
                    return str(keyword.value.value)
        return None

    def _prohibited_flags(self) -> tuple[bool, bool]:
        upx, one_file = False, False
        for node in ast.walk(self._tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "EXE":
                continue
            for keyword in node.keywords:
                if keyword.arg == "upx" and isinstance(keyword.value, ast.Constant):
                    upx = upx or bool(keyword.value.value)
                elif keyword.arg == "onefile" and isinstance(
                    keyword.value, ast.Constant
                ):
                    one_file = one_file or bool(keyword.value.value)
        return upx, one_file

    def _module_constants(self) -> dict[str, LiteralValue | None]:
        constants: dict[str, LiteralValue | None] = {}
        for node in self._tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                if isinstance(target, ast.Name):
                    constants[target.id] = _literal_value(node.value)
        return constants


def _literal_value(node: ast.AST) -> LiteralValue | None:
    match node:
        case ast.Constant(value=value) if isinstance(value, (str, int, float, bool)):
            return value
        case ast.Tuple(elts=elts) | ast.List(elts=elts):
            return tuple(
                element
                for element in (_literal_value(element) for element in elts)
                if element is not None
            )
        case _:
            return None


def _tuple_of_strings(value: LiteralValue | None) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        return ()
    return tuple(item for item in value if isinstance(item, str))


_PAIR_LENGTH: Final = 2


def _as_str_pair(item: LiteralValue) -> tuple[str, str] | None:
    """Return a 2-tuple of strings when the literal item is exactly that."""
    if (
        isinstance(item, tuple)
        and len(item) == _PAIR_LENGTH
        and isinstance(item[0], str)
        and isinstance(item[1], str)
    ):
        return (item[0], item[1])
    return None


def _tuple_of_pairs(value: LiteralValue | None) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, tuple):
        return ()
    pairs = (_as_str_pair(item) for item in value)
    return tuple(pair for pair in pairs if pair is not None)


def parse_spec(spec_path: Path) -> SpecModel:
    """Parse a PyInstaller spec into a declarative SpecModel."""
    source = spec_path.read_text(encoding="utf-8")
    return _SpecParser(ast.parse(source, filename=str(spec_path)), source).parse()
