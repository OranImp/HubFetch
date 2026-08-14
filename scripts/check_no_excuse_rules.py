"""Enforce HubFetch's no-excuse Python source rules."""

from __future__ import annotations

import ast
import io
import re
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

PURE_LOC_LIMIT: Final = 250
EXCLUDED_DIRS: Final = frozenset(
    {
        ".basedpyright",
        ".git",
        ".mypy_cache",
        ".omo",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".venv",
        "__pycache__",
        "artifacts",
        "build",
        "dist",
        "node_modules",
        "package",
    }
)
IGNORE_PATTERN: Final = re.compile(r"#\s*(type|pyright)\s*:\s*ignore\b")
SIZE_OK_PATTERN: Final = re.compile(r"#\s*noqa:\s*SIZE_OK\b")
BROAD_EXCEPT_OK_PATTERN: Final = re.compile(r"#\s*noqa:\s*BROAD_EXCEPT_OK\b")


@dataclass(frozen=True, slots=True)
class Violation:
    """A source rule violation suitable for command-line reporting."""

    path: Path
    line: int
    column: int
    rule: str
    message: str

    def render(self) -> str:
        """Render the violation in compiler-style form."""
        return f"{self.path}:{self.line}:{self.column}: [{self.rule}] {self.message}"


def discover_python_files(paths: Iterable[Path]) -> tuple[Path, ...]:
    """Resolve Python files beneath explicit files or directories."""
    discovered: set[Path] = set()
    for candidate in paths:
        path = candidate.resolve()
        if not path.exists():
            message = f"input does not exist: {path}"
            raise FileNotFoundError(message)
        if path.is_file():
            if path.suffix == ".py":
                discovered.add(path)
            continue
        for child in path.rglob("*.py"):
            if EXCLUDED_DIRS.isdisjoint(child.parts):
                discovered.add(child)
    return tuple(sorted(discovered))


def source_line(source_lines: Sequence[str], line_number: int) -> str:
    """Return a source line for a one-based AST line number."""
    return source_lines[line_number - 1]


def any_reference(node: ast.AST) -> ast.Name | ast.Attribute | None:
    """Return a typed AST reference when a node refers to typing.Any."""
    match node:
        case ast.Name(id="Any") | ast.Attribute(attr="Any"):
            return node
        case _:
            return None


def cast_call(node: ast.AST) -> ast.Call | None:
    """Return a typed call node when the node invokes cast()."""
    match node:
        case ast.Call(func=ast.Name(id="cast") | ast.Attribute(attr="cast")):
            return node
        case _:
            return None


def is_enum_comparison(node: ast.AST) -> bool:
    """Return whether a condition compares a value with an enum member."""
    if not isinstance(node, ast.Compare) or len(node.ops) != 1:
        return False
    return isinstance(node.left, ast.Attribute) or any(
        isinstance(comparator, ast.Attribute) for comparator in node.comparators
    )


def find_comment_violations(source: str, path: Path) -> list[Violation]:
    """Find forbidden type-checker suppression comments."""
    violations: list[Violation] = []
    tokens = tokenize.generate_tokens(io.StringIO(source).readline)
    for token in tokens:
        if token.type != tokenize.COMMENT:
            continue
        match = IGNORE_PATTERN.search(token.string)
        if match is None:
            continue
        kind = match.group(1)
        violations.append(
            Violation(
                path=path,
                line=token.start[0],
                column=token.start[1] + match.start() + 1,
                rule=f"{kind}-ignore",
                message=f"remove the #{kind}: ignore suppression",
            )
        )
    return violations


def find_ast_violations(
    tree: ast.Module, source_lines: Sequence[str], path: Path
) -> list[Violation]:
    """Find banned typing, exception, and enum-dispatch constructs."""
    violations: list[Violation] = []
    main_handlers = {
        handler
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "main"
        for handler in ast.walk(node)
        if isinstance(handler, ast.ExceptHandler)
    }
    for node in ast.walk(tree):
        any_node = any_reference(node)
        if any_node is not None:
            violations.append(
                Violation(
                    path,
                    any_node.lineno,
                    any_node.col_offset + 1,
                    "no-any",
                    "replace Any with a precise type",
                )
            )
        cast_node = cast_call(node)
        if cast_node is not None:
            violations.append(
                Violation(
                    path,
                    cast_node.lineno,
                    cast_node.col_offset + 1,
                    "no-cast",
                    "redesign the types instead of using cast()",
                )
            )
        if isinstance(node, ast.ExceptHandler) and (
            (
                isinstance(node.type, ast.Name)
                and node.type.id in {"Exception", "BaseException"}
            )
            or (
                isinstance(node.type, ast.Attribute)
                and node.type.attr in {"Exception", "BaseException"}
            )
        ):
            is_boundary = node in main_handlers and BROAD_EXCEPT_OK_PATTERN.search(
                source_line(source_lines, node.lineno)
            )
            if not is_boundary:
                violations.append(
                    Violation(
                        path,
                        node.lineno,
                        node.col_offset + 1,
                        "broad-except",
                        "catch a specific exception outside main() boundary",
                    )
                )
        if (
            isinstance(node, ast.If)
            and is_enum_comparison(node.test)
            and len(node.orelse) == 1
            and isinstance(node.orelse[0], ast.If)
            and is_enum_comparison(node.orelse[0].test)
        ):
            violations.append(
                Violation(
                    path,
                    node.lineno,
                    node.col_offset + 1,
                    "if-elif-on-variant",
                    "use match/case plus assert_never for enum dispatch",
                )
            )
    return violations


def find_size_violation(source_lines: Sequence[str], path: Path) -> list[Violation]:
    """Enforce the 250 pure-LOC source-module ceiling."""
    if any(SIZE_OK_PATTERN.search(line) for line in source_lines[:10]):
        return []
    pure_loc = sum(
        bool(line.strip() and not line.lstrip().startswith("#"))
        for line in source_lines
    )
    if pure_loc <= PURE_LOC_LIMIT:
        return []
    return [
        Violation(
            path,
            1,
            1,
            "oversized-module",
            f"{pure_loc} pure LOC exceeds the {PURE_LOC_LIMIT} line limit",
        )
    ]


def check_file(path: Path) -> tuple[Violation, ...]:
    """Return all no-excuse violations in one Python file."""
    source = path.read_text(encoding="utf-8")
    source_lines = source.splitlines()
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as error:
        return (
            Violation(
                path,
                error.lineno or 1,
                error.offset or 1,
                "syntax-error",
                error.msg,
            ),
        )
    return (
        *find_comment_violations(source, path),
        *find_ast_violations(tree, source_lines, path),
        *find_size_violation(source_lines, path),
    )


def main(arguments: Sequence[str] | None = None) -> int:
    """Run the checker against explicit paths, defaulting to the repository."""
    paths = tuple(Path(value) for value in (arguments or (".",)))
    try:
        files = discover_python_files(paths)
        violations = tuple(
            violation for path in files for violation in check_file(path)
        )
    except (FileNotFoundError, OSError, UnicodeError, tokenize.TokenError) as error:
        print(f"check-no-excuse-rules: {error}", file=sys.stderr)
        return 2
    for violation in violations:
        print(violation.render(), file=sys.stderr)
    if violations:
        print(f"{len(violations)} violation(s)", file=sys.stderr)
        return 1
    print(f"no violations in {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
