"""Fake system Git executable fixtures for clone tests.

Each fixture writes a real Python script that stands in for the ``git``
executable, then runs it through the production cloner and readiness checker
via ``sys.executable``. Behavior is driven by a JSON payload placed in the
child environment: argv-prefix handlers carry a scripted stdout/stderr line
schedule, an optional exit code, an optional destination it populates (to
simulate a partial working copy), an argv recorder, and a start/end log used
to prove an interrupted run.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final

import pytest

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from pathlib import Path

FAKE_GIT_SOURCE: Final = (
    "import json, os, sys, time\n"
    "\n"
    "\n"
    "def emit_output(handler, log):\n"
    '    output = handler.get("stdout", "")\n'
    "    if output:\n"
    "        sys.stdout.write(output)\n"
    "        sys.stdout.flush()\n"
    "    if log:\n"
    '        with open(log, "a", encoding="utf-8") as handle:\n'
    '            handle.write("start\\n")\n'
    '    for line in handler.get("stderr", []):\n'
    '        sys.stderr.write(line["text"])\n'
    "        sys.stderr.flush()\n"
    '        delay = line.get("delay", 0.0)\n'
    "        if delay:\n"
    "            time.sleep(delay)\n"
    "    if log:\n"
    '        with open(log, "a", encoding="utf-8") as handle:\n'
    '            handle.write("end\\n")\n'
    "\n"
    "\n"
    "def main() -> None:\n"
    '    with open(os.environ["FAKE_GIT_BEHAVIOR"], encoding="utf-8") as handle:\n'
    "        behavior = json.load(handle)\n"
    "    argv = sys.argv[1:]\n"
    "    handler = None\n"
    '    for candidate in behavior.get("handlers", []):\n'
    '        match = candidate["match"]\n'
    "        if argv[: len(match)] == match:\n"
    "            handler = candidate\n"
    "            break\n"
    "    if handler is None:\n"
    '        sys.exit(behavior.get("fallback_exit", 0))\n'
    '    record = handler.get("record")\n'
    "    if record:\n"
    '        with open(record, "a", encoding="utf-8") as handle:\n'
    '            handle.write("\\x1f".join(argv) + "\\n")\n'
    '    destination = handler.get("destination")\n'
    "    if destination:\n"
    "        os.makedirs(destination, exist_ok=True)\n"
    "        with open(\n"
    '            os.path.join(destination, "partial-file.txt"),\n'
    '            "w",\n'
    '            encoding="utf-8",\n'
    "        ) as handle:\n"
    '            handle.write("partial")\n'
    '    emit_output(handler, handler.get("log"))\n'
    '    sys.exit(handler.get("exit_code", 0))\n'
    "\n"
    "\n"
    'if __name__ == "__main__":\n'
    "    main()\n"
)
"""Real executable script written into a per-test temporary directory."""


@dataclass(frozen=True, slots=True)
class FakeGitHandler:
    """One scripted argv-prefix response for the fake git executable."""

    match: tuple[str, ...]
    stderr: tuple[tuple[str, float], ...] = ()
    stdout: str = ""
    exit_code: int = 0
    destination: Path | None = None
    record: Path | None = None
    log: Path | None = None


VERSION_HANDLER: Final = FakeGitHandler(
    match=("--version",), stdout="git version 2.54.0.windows.1\n"
)
"""Default ``git --version`` probe response that reports an installed Git."""


def write_fake_git(
    tmp_path: Path,
    handlers: Sequence[FakeGitHandler],
    *,
    fallback_exit: int = 128,
) -> tuple[Path, Path]:
    """Write the fake executable and its behavior payload, returning both paths."""
    script = tmp_path / "fake_git.py"
    _ = script.write_text(FAKE_GIT_SOURCE, encoding="utf-8")
    behavior: dict[str, object] = {
        "handlers": [
            {
                "match": list(handler.match),
                "stderr": [
                    {"text": text, "delay": delay} for text, delay in handler.stderr
                ],
                "stdout": handler.stdout,
                "exit_code": handler.exit_code,
                "destination": (
                    str(handler.destination)
                    if handler.destination is not None
                    else None
                ),
                "record": str(handler.record) if handler.record is not None else None,
                "log": str(handler.log) if handler.log is not None else None,
            }
            for handler in handlers
        ],
        "fallback_exit": fallback_exit,
    }
    behavior_path = tmp_path / "fake_git_behavior.json"
    _ = behavior_path.write_text(json.dumps(behavior), encoding="utf-8")
    return script, behavior_path


def fake_git_environment(behavior_path: Path) -> dict[str, str]:
    """Return a child environment that locates the fake behavior payload."""
    return {**os.environ, "FAKE_GIT_BEHAVIOR": str(behavior_path)}


def read_recorded_argv(record: Path) -> tuple[tuple[str, ...], ...]:
    """Read argv lines recorded by the fake executable in invocation order."""
    entries: list[tuple[str, ...]] = []
    for line in record.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        entries.append(tuple(line.split("\x1f")))
    return tuple(entries)


@pytest.fixture
def fake_git(tmp_path: Path) -> Callable[..., tuple[tuple[str, ...], dict[str, str]]]:
    """Return a builder for a configured fake git command and environment."""

    def build(
        handlers: Sequence[FakeGitHandler], *, fallback_exit: int = 128
    ) -> tuple[tuple[str, ...], dict[str, str]]:
        script, behavior_path = write_fake_git(
            tmp_path, handlers, fallback_exit=fallback_exit
        )
        return (sys.executable, str(script)), fake_git_environment(behavior_path)

    return build
